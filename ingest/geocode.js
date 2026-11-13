// Permit locations run (ADR-14 step 2, ADR-15 item 4). Gives each permit one
// point, taking the first of:
//   1. the source's own coordinates, from the permit's latest raw payload
//   2. the appraiser parcel the permit is joined to (permit_parcels)
//   3. the US Census batch geocoder, on the permit's job-site address
// Only job-site addresses are sent to the Census; contractor business
// addresses never are. Census answers are cached by address, a miss is
// asked again only after RETRY_MISS_DAYS, and at most --max new addresses are
// sent per run. The run is a sync_runs row of 'us-census-geocoder' (rule 3).
//
//   node ingest/geocode.js [--max=20000]

const db = require('../db/index.js');
const { SOURCES } = require('../src/sources.js');
const G = require('../src/enrichment/geocode.js');
const { parseCsvLine } = require('../src/enrichment/licences.js');
const { fetchWithRetry } = require('../src/adapters/http.js');
const { classifyError } = require('./raw.js');

const SLUG = 'us-census-geocoder';
const REQUEST_ROWS = 2000; // well under the 10,000 limit, so one slow answer costs little
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const RETRY_MISS_DAYS = 30;

const quiet = { info: () => {}, warning: (m) => console.error(`warning: ${m}`) };

/** Source points: latest raw payload per permit of each source with `coordinates`. */
async function sourcePoints() {
  const cfg = Object.fromEntries(Object.entries(SOURCES).filter(([, s]) => s.coordinates).map(([slug, s]) => [slug, s.coordinates]));
  if (!Object.keys(cfg).length) return [];
  const { rows } = await db.query(`
    SELECT DISTINCT ON (r.source_id, r.source_key)
           p.id AS permit_id, r.id AS raw_record_id,
           r.payload ->> (($2::jsonb) -> s.slug ->> 'lat') AS lat,
           r.payload ->> (($2::jsonb) -> s.slug ->> 'lng') AS lng
      FROM raw_records r
      JOIN sources s ON s.id = r.source_id
      JOIN permits p ON p.source_area = s.slug AND p.permit_number = r.source_key
     WHERE s.slug = ANY($1::text[])
     ORDER BY r.source_id, r.source_key, r.fetched_at DESC, r.id DESC`, [Object.keys(cfg), JSON.stringify(cfg)]);
  return rows.map((r) => ({ permitId: String(r.permit_id), rawRecordId: r.raw_record_id, ...G.point(r.lat, r.lng) }))
    .filter((r) => r.lat != null);
}

async function parcelPoints() {
  const { rows } = await db.query(`
    SELECT DISTINCT ON (pp.permit_id) pp.permit_id, c.id AS parcel_id, c.lat, c.lng
      FROM permit_parcels pp JOIN parcels c ON c.id = pp.parcel_id
     WHERE c.found AND c.lat IS NOT NULL AND c.lng IS NOT NULL
     ORDER BY pp.permit_id, pp.provider`);
  return rows.map((r) => ({ permitId: String(r.permit_id), parcelId: r.parcel_id, ...G.point(r.lat, r.lng) }))
    .filter((r) => r.lat != null);
}

/** Job-site addresses of permit-feed permits, with the state from the source when the row has none. */
async function permitAddresses() {
  const { rows } = await db.query(`
    SELECT p.id AS permit_id, coalesce(p.street, p.address) AS street, p.city, coalesce(p.state, j.state) AS state, p.zip
      FROM permits p
      JOIN sources s ON s.slug = p.source_area AND s.role = 'permits'
      JOIN jurisdictions j ON j.id = s.jurisdiction_id`);
  return rows.map((r) => ({ permitId: String(r.permit_id), key: G.addressKey(r) }));
}

async function askCensus(items, fetchImpl) {
  const form = new FormData();
  form.append('addressFile', new Blob([G.buildCensusCsv(items)], { type: 'text/csv' }), 'addresses.csv');
  form.append('benchmark', G.CENSUS.benchmark);
  const timed = (u, init) => fetchImpl(u, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const res = await fetchWithRetry(timed, G.CENSUS.url, { method: 'POST', body: form }, { log: quiet });
  if (!res.ok) throw new Error(`HTTP ${res.status} from the Census geocoder`);
  const text = await res.text();
  const out = G.parseCensusResult(text, parseCsvLine);
  // An error page parses to rows with no ids we sent; that is a schema change, not "no match".
  const answered = items.filter((i) => out.has(String(i.id))).length;
  if (answered < items.length * 0.9) throw new Error(`schema: Census answered ${answered} of ${items.length} rows (${text.slice(0, 120)})`);
  return out;
}

async function writeCache(answers, runId) {
  if (!answers.length) return;
  const col = (f) => answers.map((a) => (a[f] === undefined ? null : a[f]));
  await db.query(`
    INSERT INTO geocode_cache (address_key, matched, quality, lat, lng, matched_address, benchmark, geocoded_at, sync_run_id)
    SELECT t.*, $7, now(), $8 FROM unnest($1::text[], $2::bool[], $3::text[], $4::float8[], $5::float8[], $6::text[]) AS t
    ON CONFLICT (address_key) DO UPDATE SET
      matched = EXCLUDED.matched, quality = EXCLUDED.quality, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
      matched_address = EXCLUDED.matched_address, benchmark = EXCLUDED.benchmark, geocoded_at = now(), sync_run_id = EXCLUDED.sync_run_id`,
  [col('key'), col('matched'), col('quality'), col('lat'), col('lng'), col('matchedAddress'), G.CENSUS.benchmark, runId]);
}

/** Upserts the chosen point per permit; rows that did not change are not rewritten. */
async function writeLocations(locs, runId) {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const col = (f) => locs.map((l) => (l[f] === undefined ? null : l[f]));
    const { rowCount } = await client.query(`
      INSERT INTO permit_locations (permit_id, lat, lng, method, quality, raw_record_id, parcel_id, address_key, located_at, sync_run_id)
      SELECT t.*, now(), $9 FROM unnest($1::bigint[], $2::float8[], $3::float8[], $4::text[], $5::text[], $6::bigint[], $7::bigint[], $8::text[]) AS t
      ON CONFLICT (permit_id) DO UPDATE SET
        lat = EXCLUDED.lat, lng = EXCLUDED.lng, method = EXCLUDED.method, quality = EXCLUDED.quality,
        raw_record_id = EXCLUDED.raw_record_id, parcel_id = EXCLUDED.parcel_id, address_key = EXCLUDED.address_key,
        located_at = now(), sync_run_id = EXCLUDED.sync_run_id
      WHERE (permit_locations.lat, permit_locations.lng, permit_locations.method, permit_locations.quality,
             permit_locations.raw_record_id, permit_locations.parcel_id, permit_locations.address_key)
            IS DISTINCT FROM (EXCLUDED.lat, EXCLUDED.lng, EXCLUDED.method, EXCLUDED.quality,
             EXCLUDED.raw_record_id, EXCLUDED.parcel_id, EXCLUDED.address_key)`,
    [col('permitId'), col('lat'), col('lng'), col('method'), col('quality'), col('rawRecordId'), col('parcelId'), col('addressKey'), runId]);
    // A permit whose point went away (source dropped it, parcel unlinked) has no location now.
    const { rowCount: removed } = await client.query(
      'DELETE FROM permit_locations WHERE NOT (permit_id = ANY($1::bigint[]))', [col('permitId')]);
    await client.query('COMMIT');
    return { changed: rowCount, removed };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function geocodePermits({ max = 20000, fetchImpl = fetch, kind = 'scheduled' } = {}) {
  const runId = await db.startSyncRun(await db.getSourceId(SLUG), kind);
  let requests = 0;
  let asked = 0;
  try {
    const chosen = new Map();
    for (const s of await sourcePoints()) chosen.set(s.permitId, { ...s, method: 'source' });
    for (const p of await parcelPoints()) if (!chosen.has(p.permitId)) chosen.set(p.permitId, { ...p, method: 'parcel' });

    const needs = (await permitAddresses()).filter((a) => !chosen.has(a.permitId));
    const keys = [...new Set(needs.map((a) => a.key).filter(Boolean))];
    const { rows: due } = await db.query(`
      SELECT k FROM unnest($1::text[]) AS k LEFT JOIN geocode_cache c ON c.address_key = k
       WHERE c.address_key IS NULL OR (NOT c.matched AND c.geocoded_at < now() - make_interval(days => $2))
       ORDER BY c.geocoded_at NULLS FIRST, k LIMIT $3`, [keys, RETRY_MISS_DAYS, max]);
    const todo = due.map((r) => r.k);
    let matched = 0;
    for (let i = 0; i < todo.length; i += REQUEST_ROWS) {
      const items = todo.slice(i, i + REQUEST_ROWS).map((key, n) => ({ id: String(i + n + 1), key }));
      const out = await askCensus(items, fetchImpl);
      requests += 1;
      asked += items.length;
      const answers = items.map((it) => ({ key: it.key, ...(out.get(it.id) || { matched: false, quality: 'no_match' }) }));
      matched += answers.filter((a) => a.matched).length;
      await writeCache(answers, runId); // saved per request, so a later failure keeps what was paid for
    }

    const { rows: hits } = await db.query(
      'SELECT address_key, lat, lng, quality FROM geocode_cache WHERE matched AND address_key = ANY($1::text[])', [keys]);
    const byKey = new Map(hits.map((h) => [h.address_key, h]));
    for (const a of needs) {
      const h = a.key && byKey.get(a.key);
      if (h) chosen.set(a.permitId, { permitId: a.permitId, lat: h.lat, lng: h.lng, method: 'census', quality: h.quality, addressKey: a.key });
    }

    const locs = [...chosen.values()];
    const written = await writeLocations(locs, runId);
    const byMethod = locs.reduce((m, l) => ({ ...m, [l.method]: (m[l.method] || 0) + 1 }), {});
    await db.finishSyncRun(runId, { status: 'succeeded', requests, fetched: asked, newCount: matched, changed: written.changed });
    return { asked, matched, byMethod, located: locs.length, unlocated: needs.length - (byMethod.census || 0), ...written };
  } catch (err) {
    await db.finishSyncRun(runId, { status: 'failed', requests, errorClass: classifyError(err), errorDetail: String(err.stack || err.message).slice(0, 4000) });
    throw err;
  }
}

async function main() {
  const max = Number((process.argv.find((a) => a.startsWith('--max=')) || '--max=20000').split('=')[1]);
  await db.applySchema();
  const s = await geocodePermits({ max });
  const { rows } = await db.query(`
    SELECT p.source_area, count(*)::int AS permits, count(l.permit_id)::int AS located,
           count(*) FILTER (WHERE l.method = 'source')::int AS source, count(*) FILTER (WHERE l.method = 'parcel')::int AS parcel,
           count(*) FILTER (WHERE l.method = 'census')::int AS census
      FROM permits p JOIN sources s ON s.slug = p.source_area AND s.role = 'permits'
      LEFT JOIN permit_locations l ON l.permit_id = p.id
     GROUP BY 1 ORDER BY 1`);
  console.log(`Locations: Census asked ${s.asked} new addresses, matched ${s.matched}. ${s.located} permits located `
    + `(${JSON.stringify(s.byMethod)}); ${s.changed} rows changed, ${s.removed} removed.`);
  for (const r of rows) {
    console.log(`  ${r.source_area}: ${r.located} of ${r.permits} (${((100 * r.located) / r.permits).toFixed(1)}%) `
      + `[source ${r.source}, parcel ${r.parcel}, census ${r.census}]`);
  }
  await db.close();
}

if (require.main === module) {
  main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
}

module.exports = { geocodePermits, sourcePoints, parcelPoints, permitAddresses };
