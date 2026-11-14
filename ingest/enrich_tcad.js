// Travis CAD run (ADR-15 step 3b). Reads the supplemental appraisal export
// and stores property facts for the parcels Austin permits name, then links
// the permits. Owner, deed, exemption and sale fields are never read
// (src/enrichment/tcad.js); a confidential parcel is skipped, and a parcel
// that turns confidential is deleted on the next run.
//
// The export is a ~510 MB zip of fixed-width files (PROP.TXT is 4.9 GB
// unzipped). It is downloaded to a temp dir and streamed with `unzip -p`, so
// nothing large is held in memory or kept on disk after the run.
//
//   node ingest/enrich_tcad.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, execFileSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { HOLDS } = require('../src/holds.js');
const db = require('../db/index.js');
const T = require('../src/enrichment/tcad.js');
const { classifyError } = require('./raw.js');

const SLUG = T.PROVIDER.slug;
const MIN_PROP_ROWS = 100000; // Travis County has ~490k; fewer means a broken file

/** Latest raw payload per Austin permit with its tcad_id. */
async function permitKeys() {
  const fields = T.PROVIDER.permitKeyFields;
  const { rows } = await db.query(`
    SELECT DISTINCT ON (r.source_id, r.source_key) p.id AS permit_id, r.id AS raw_record_id,
           r.payload ->> (($2::jsonb) ->> s.slug) AS key
      FROM raw_records r JOIN sources s ON s.id = r.source_id
      JOIN permits p ON p.source_area = s.slug AND p.permit_number = r.source_key
     WHERE s.slug = ANY($1::text[])
     ORDER BY r.source_id, r.source_key, r.fetched_at DESC, r.id DESC`, [Object.keys(fields), JSON.stringify(fields)]);
  return rows.map((r) => ({ permitId: r.permit_id, rawRecordId: r.raw_record_id, key: T.permitKey(r.key) })).filter((r) => r.key);
}

/** Production file access: download the zip once, stream entries by name. */
async function zipFiles(fetchImpl) {
  let url = null;
  try {
    const page = await fetchImpl(T.PROVIDER.page);
    if (page.ok) url = T.findExportLink(await page.text());
  } catch { /* the known link below is tried instead */ }
  url = url || T.PROVIDER.knownFile;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from the Travis CAD export (${url})`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcad-'));
  const zip = path.join(dir, 'export.zip');
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(zip));
  const names = execFileSync('unzip', ['-Z1', zip]).toString().split('\n').map((n) => n.trim()).filter(Boolean);
  const lm = res.headers.get('last-modified');
  return {
    url,
    fileDate: lm ? new Date(lm) : null,
    names,
    lines: (name) => readline.createInterface({ input: spawn('unzip', ['-p', zip, name]).stdout.setEncoding('latin1'), crlfDelay: Infinity }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const entry = (names, re) => {
  const n = names.find((x) => re.test(x));
  if (!n) throw new Error(`schema: Travis CAD export has no ${re} (entries: ${names.slice(0, 30).join(', ')})`);
  return n;
};

async function enrichTcad({ fetchImpl = fetch, files = null, kind = 'scheduled', minPropRows = MIN_PROP_ROWS, holds = HOLDS } = {}) {
  const runId = await db.startSyncRun(await db.getSourceId(SLUG), kind);
  let src = null;
  try {
    const permits = await permitKeys();
    const geoIds = new Set(permits.filter((p) => p.key.geoId).map((p) => p.key.geoId));
    const propIds = new Set(permits.filter((p) => p.key.propId).map((p) => p.key.propId));
    src = files || await zipFiles(fetchImpl);

    // 1. Properties a permit names. The id columns are checked before a line is parsed.
    const props = new Map();
    const byGeo = new Map();
    const stats = { propRows: 0, wanted: 0, confidential: 0, otherSkip: 0, improvements: 0, floors: 0 };
    for await (const line of src.lines(entry(src.names, /(^|\/)PROP\.TXT$/i))) {
      if (!line) continue;
      stats.propRows += 1;
      const geo = line.slice(T.PROP.geoId[0] - 1, T.PROP.geoId[1]).trim();
      const pid = line.slice(T.PROP.propId[0] - 1, T.PROP.propId[1]).trim().replace(/^0+/, '');
      if (!geoIds.has(geo) && !propIds.has(pid)) continue;
      stats.wanted += 1;
      const p = T.mapProp(line);
      if (p.skip) { stats[p.skip === 'confidential' ? 'confidential' : 'otherSkip'] += 1; continue; }
      props.set(p.propId, { ...p, improvements: [], floors: [] });
      if (p.geoId) byGeo.set(p.geoId, [...(byGeo.get(p.geoId) || []), p]);
    }
    if (stats.propRows < minPropRows) throw new Error(`schema: PROP.TXT had ${stats.propRows} rows`);

    // 2. Improvements and their floor rows, for those properties only.
    for await (const line of src.lines(entry(src.names, /(^|\/)IMP_INFO\.TXT$/i))) {
      const i = line && T.mapImprovement(line);
      if (i && props.has(i.propId)) { props.get(i.propId).improvements.push(i); stats.improvements += 1; }
    }
    for await (const line of src.lines(entry(src.names, /(^|\/)IMP_DET\.TXT$/i))) {
      const f = line && T.mapFloor(line);
      if (f && props.has(f.propId)) { props.get(f.propId).floors.push(f); stats.floors += 1; }
    }

    // 3. Lot size: the sum of each property's land segments. An export
    // without the land file still loads, with lot size missing (NULL).
    // Held until the verification audit passes it (src/holds.js).
    const landName = holds.tcadLotSize ? null : src.names.find((x) => /(^|\/)LAND_DET\.TXT$/i.test(x));
    stats.landSegments = 0;
    if (landName) {
      for await (const line of src.lines(landName)) {
        const l = line && T.mapLand(line);
        if (l && props.has(l.propId)) { const p = props.get(l.propId); p.lotSqft = (p.lotSqft || 0) + l.sqft; stats.landSegments += 1; }
      }
    }

    const rows = [...props.values()].map((p) => ({ ...p, ...T.summarize(p.improvements, p.floors) }));
    const linked = await write(rows, permits, byGeo, runId, src.fileDate);
    const out = { ...stats, stored: rows.length, ...linked, url: src.url, fileDate: src.fileDate,
      withYear: rows.filter((r) => r.yearBuilt).length, withArea: rows.filter((r) => r.livingSqft).length,
      withLot: rows.filter((r) => r.lotSqft).length };
    await db.finishSyncRun(runId, { status: 'succeeded', requests: files ? 0 : 2, fetched: stats.propRows, newCount: rows.length, changed: linked.linked });
    return out;
  } catch (err) {
    await db.finishSyncRun(runId, { status: 'failed', requests: 0, errorClass: classifyError(err), errorDetail: String(err.stack || err.message).slice(0, 4000) });
    throw err;
  } finally {
    if (src && src.cleanup) src.cleanup();
  }
}

/**
 * Upserts the parcels, deletes this provider's parcels not seen in this run
 * (dropped from the roll, or now confidential), and rebuilds the permit links.
 * A geo_id shared by more than one real property is ambiguous and not linked.
 */
async function write(rows, permits, byGeo, runId, fileDate) {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const col = (f) => rows.map((r) => (r[f] === undefined ? null : r[f]));
    const payload = rows.map((r) => JSON.stringify({ prop_id: r.propId, geo_id: r.geoId, prop_type_cd: r.propType, prop_val_yr: r.rollYear,
      state_cd: r.stateCode, improvement_type: r.improvementType, land_value: r.landValue, improvement_value: r.improvementValue }));
    await client.query(`
      INSERT INTO parcels (provider, parcel_key, found, land_use_code, year_built, heated_sqft, assessment_year, site_city, site_zip,
                           land_value, improvement_value, improvement_type, payload, source_edited_at, fetched_at, sync_run_id, lot_sqft)
      SELECT $1, t.k, true, t.code, t.yr, t.sqft, t.roll, t.city, t.zip, t.land, t.imprv, t.itype, t.payload, $13, now(), $14, t.lot
        FROM unnest($2::text[], $3::text[], $4::int[], $5::numeric[], $6::int[], $7::text[], $8::text[], $9::numeric[], $10::numeric[],
                    $11::text[], $12::jsonb[], $15::numeric[]) AS t(k, code, yr, sqft, roll, city, zip, land, imprv, itype, payload, lot)
      ON CONFLICT (provider, parcel_key) DO UPDATE SET
        found = true, land_use_code = EXCLUDED.land_use_code, year_built = EXCLUDED.year_built, heated_sqft = EXCLUDED.heated_sqft,
        lot_sqft = EXCLUDED.lot_sqft,
        assessment_year = EXCLUDED.assessment_year, site_city = EXCLUDED.site_city, site_zip = EXCLUDED.site_zip,
        land_value = EXCLUDED.land_value, improvement_value = EXCLUDED.improvement_value, improvement_type = EXCLUDED.improvement_type,
        payload = EXCLUDED.payload, source_edited_at = EXCLUDED.source_edited_at, fetched_at = now(), sync_run_id = EXCLUDED.sync_run_id`,
    [SLUG, col('propId'), col('stateCode'), col('yearBuilt'), col('livingSqft'), col('rollYear'), col('siteCity'), col('siteZip'),
      col('landValue'), col('improvementValue'), col('improvementType'), payload, fileDate, runId, col('lotSqft')]);
    const { rowCount: removed } = await client.query('DELETE FROM parcels WHERE provider = $1 AND sync_run_id <> $2', [SLUG, runId]);

    await client.query('DELETE FROM permit_parcels WHERE provider = $1', [SLUG]);
    const links = [];
    let ambiguous = 0;
    for (const p of permits) {
      let propId = p.key.propId;
      let rule = 'tcad_prop_id';
      if (p.key.geoId) {
        const all = byGeo.get(p.key.geoId) || [];
        const real = all.filter((x) => x.propType === 'R');
        const pick = real.length ? real : all;
        if (pick.length > 1) { ambiguous += 1; continue; }
        propId = pick[0] && pick[0].propId;
        rule = 'tcad_geo_id';
      }
      if (propId) links.push({ ...p, propId, rule });
    }
    const { rowCount: linked } = await client.query(`
      INSERT INTO permit_parcels (permit_id, provider, parcel_id, match_rule, raw_record_id)
      SELECT t.permit_id, $1, c.id, t.rule, t.raw_record_id
        FROM unnest($2::bigint[], $3::text[], $4::text[], $5::bigint[]) AS t(permit_id, k, rule, raw_record_id)
        JOIN parcels c ON c.provider = $1 AND c.parcel_key = t.k
      ON CONFLICT DO NOTHING`,
    [SLUG, links.map((l) => l.permitId), links.map((l) => l.propId), links.map((l) => l.rule), links.map((l) => l.rawRecordId)]);
    await client.query('COMMIT');
    return { linked, removed, ambiguous, permitsWithKey: permits.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  await db.applySchema();
  const s = await enrichTcad();
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
  console.log(`Travis CAD: ${s.propRows} properties read from ${s.url} (file dated ${s.fileDate ? s.fileDate.toISOString().slice(0, 10) : 'unknown'}). `
    + `${s.wanted} named by Austin permits; ${s.confidential} confidential and skipped; ${s.stored} stored `
    + `(year built ${pct(s.withYear, s.stored)}, living area ${pct(s.withArea, s.stored)}, lot size ${pct(s.withLot, s.stored)}), ${s.removed} removed. `
    + `${s.linked} of ${s.permitsWithKey} permits with a tcad_id linked (${pct(s.linked, s.permitsWithKey)}); ${s.ambiguous} ambiguous.`);
  await db.close();
}

if (require.main === module) {
  main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
}

module.exports = { enrichTcad, permitKeys };
