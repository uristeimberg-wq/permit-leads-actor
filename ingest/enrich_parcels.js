// Property enrichment run (ADR-14 step 3). For every permit whose source
// publishes a parcel id, reads that parcel from the provider and links the two.
//
// - The join key is the source's own parcel id (Miami-Dade folio, Wake PIN), taken from
//   the permit's latest raw payload, so history is covered without a re-sync.
// - Only parcels never fetched, or older than the provider's refreshDays, are
//   requested; a parcel the provider does not have is stored as found = false
//   so it is not asked for again every day.
// - Every run is a sync_runs row for the provider's source, with its error
//   class, so source_health and the health alarm watch it (rule 3).
//
//   node ingest/enrich_parcels.js [--provider=miami-dade-pa|wake-parcels|austin-parcels] [--max=20000]

const db = require('../db/index.js');
const { PROVIDERS, buildParcelQuery, mapParcel } = require('../src/enrichment/parcels.js');
const { fetchWithRetry } = require('../src/adapters/http.js');
const { classifyError } = require('./raw.js');

const BATCH = 100;

const quiet = { info: () => {}, warning: (m) => console.error(`warning: ${m}`), error: (m) => console.error(m) };

/** Latest raw payload per permit of the given sources, with its parcel key. */
async function permitKeys(provider) {
  const slugs = Object.keys(provider.permitKeyFields);
  const { rows } = await db.query(`
    SELECT DISTINCT ON (r.source_id, r.source_key)
           p.id AS permit_id, r.id AS raw_record_id, s.slug,
           r.payload -> (($2::jsonb) ->> s.slug) AS key
      FROM raw_records r
      JOIN sources s ON s.id = r.source_id
      JOIN permits p ON p.source_area = s.slug AND p.permit_number = r.source_key
     WHERE s.slug = ANY($1::text[])
     ORDER BY r.source_id, r.source_key, r.fetched_at DESC, r.id DESC`, [slugs, JSON.stringify(provider.permitKeyFields)]);
  return rows.map((r) => ({ permitId: r.permit_id, rawRecordId: r.raw_record_id, slug: r.slug, parcelKey: provider.normalizeKey(r.key) }));
}

async function getJson(url, fetchImpl, form) {
  const init = form == null ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form };
  const res = await fetchWithRetry(fetchImpl, url, init, { log: quiet });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.slice(0, 120)}`);
  const body = await res.json();
  if (body.error) throw new Error(`ArcGIS error ${body.error.code}: ${body.error.message}`);
  return body;
}

async function enrichParcels({ providerSlug = 'miami-dade-pa', max = 20000, fetchImpl = fetch, kind = 'scheduled' } = {}) {
  const provider = PROVIDERS[providerSlug];
  if (!provider) throw new Error(`Unknown provider ${providerSlug}`);
  const sourceId = await db.getSourceId(providerSlug);
  const runId = await db.startSyncRun(sourceId, kind);
  let requests = 0;
  try {
    const permits = await permitKeys(provider);
    const keys = [...new Set(permits.map((p) => p.parcelKey).filter(Boolean))];

    // Missing first, then the stalest; at most `max` per run.
    const { rows: due } = await db.query(`
      SELECT k FROM unnest($1::text[]) AS k
        LEFT JOIN parcels c ON c.provider = $2 AND c.parcel_key = k
       WHERE c.id IS NULL OR c.fetched_at < now() - make_interval(days => $3)
       ORDER BY c.fetched_at NULLS FIRST, k
       LIMIT $4`, [keys, providerSlug, provider.refreshDays, max]);
    const todo = due.map((r) => r.k);

    const meta = await getJson(`${provider.layerUrl}?f=json`, fetchImpl);
    requests += 1;
    const editedAt = meta.editingInfo && meta.editingInfo.lastEditDate ? new Date(meta.editingInfo.lastEditDate) : null;

    let found = 0;
    let inserted = 0;
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const q = buildParcelQuery(provider, batch);
      const body = await getJson(q.url, fetchImpl, q.body);
      requests += 1;
      const byKey = new Map();
      for (const f of body.features || []) {
        const p = mapParcel(f, provider);
        if (p.parcelKey) byKey.set(p.parcelKey, p);
      }
      found += byKey.size;
      const rows = batch.map((k) => byKey.get(k) || { parcelKey: k, missing: true, payload: {} });
      const col = (f) => rows.map((r) => (r[f] === undefined ? null : r[f]));
      const { rows: res } = await db.query(`
        INSERT INTO parcels (provider, parcel_key, found, land_use_code, land_use, year_built, heated_sqft, building_sqft,
                             lot_sqft, bedrooms, bathrooms, units, floors, assessed_value, assessment_year, site_city,
                             site_zip, lat, lng, payload, land_value, improvement_value, source_edited_at, fetched_at, sync_run_id)
        SELECT $1, t.*, $23, now(), $24 FROM unnest($2::text[], $3::bool[], $4::text[], $5::text[], $6::int[], $7::numeric[],
               $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[], $14::numeric[],
               $15::int[], $16::text[], $17::text[], $18::float8[], $19::float8[], $20::jsonb[], $21::numeric[], $22::numeric[]) AS t
        ON CONFLICT (provider, parcel_key) DO UPDATE SET
          found = EXCLUDED.found, land_use_code = EXCLUDED.land_use_code, land_use = EXCLUDED.land_use,
          year_built = EXCLUDED.year_built, heated_sqft = EXCLUDED.heated_sqft, building_sqft = EXCLUDED.building_sqft,
          lot_sqft = EXCLUDED.lot_sqft, bedrooms = EXCLUDED.bedrooms, bathrooms = EXCLUDED.bathrooms, units = EXCLUDED.units,
          floors = EXCLUDED.floors, assessed_value = EXCLUDED.assessed_value, assessment_year = EXCLUDED.assessment_year,
          site_city = EXCLUDED.site_city, site_zip = EXCLUDED.site_zip, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
          payload = EXCLUDED.payload, land_value = EXCLUDED.land_value, improvement_value = EXCLUDED.improvement_value,
          source_edited_at = EXCLUDED.source_edited_at, fetched_at = now(),
          sync_run_id = EXCLUDED.sync_run_id
        RETURNING (xmax = 0) AS inserted`,
      [providerSlug, col('parcelKey'), rows.map((r) => !r.missing), col('landUseCode'), col('landUse'), col('yearBuilt'),
        col('heatedSqft'), col('buildingSqft'), col('lotSqft'), col('bedrooms'), col('bathrooms'), col('units'), col('floors'),
        col('assessedValue'), col('assessmentYear'), col('siteCity'), col('siteZip'), col('lat'), col('lng'),
        rows.map((r) => JSON.stringify(r.payload)), col('landValue'), col('improvementValue'), editedAt, runId]);
      inserted += res.filter((r) => r.inserted).length;
    }

    // Rebuild this provider's links from the current keys.
    const pool = db.getPool();
    const client = await pool.connect();
    let linked = 0;
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM permit_parcels WHERE provider = $1', [providerSlug]);
      const withKey = permits.filter((p) => p.parcelKey);
      const { rowCount } = await client.query(`
        INSERT INTO permit_parcels (permit_id, provider, parcel_id, match_rule, raw_record_id)
        SELECT t.permit_id, $1, c.id, $5, t.raw_record_id
          FROM unnest($2::bigint[], $3::text[], $4::bigint[]) AS t(permit_id, parcel_key, raw_record_id)
          JOIN parcels c ON c.provider = $1 AND c.parcel_key = t.parcel_key AND c.found
        ON CONFLICT DO NOTHING`,
      [providerSlug, withKey.map((p) => p.permitId), withKey.map((p) => p.parcelKey), withKey.map((p) => p.rawRecordId), provider.matchRule]);
      linked = rowCount;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const stats = {
      permits: permits.length, permitsWithKey: permits.filter((p) => p.parcelKey).length, distinctKeys: keys.length,
      requested: todo.length, found, inserted, linked, sourceEditedAt: editedAt && editedAt.toISOString(),
    };
    await db.finishSyncRun(runId, { status: 'succeeded', requests, fetched: todo.length, newCount: inserted, changed: found - inserted });
    return stats;
  } catch (err) {
    await db.finishSyncRun(runId, {
      status: 'failed', requests, errorClass: classifyError(err), errorDetail: String(err.stack || err.message).slice(0, 4000),
    });
    throw err;
  }
}

async function main() {
  const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
  await db.applySchema();
  const stats = await enrichParcels({ providerSlug: arg('provider', 'miami-dade-pa'), max: Number(arg('max', 20000)) });
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
  console.log(`Parcels (${arg('provider', 'miami-dade-pa')}): ${stats.permitsWithKey} of ${stats.permits} permits carry a parcel id `
    + `(${stats.distinctKeys} distinct). Requested ${stats.requested}, found ${stats.found} (${pct(stats.found, stats.requested)}), `
    + `${stats.inserted} new. ${stats.linked} permits linked (${pct(stats.linked, stats.permitsWithKey)} of those with an id). `
    + `Layer last edited ${stats.sourceEditedAt || 'unknown'}.`);
  await db.close();
}

if (require.main === module) {
  main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
}

module.exports = { enrichParcels, permitKeys };
