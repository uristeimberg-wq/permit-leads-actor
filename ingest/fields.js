// Field observations run (ADR-23, DATA_ENGINE_PLAN 6.3). After parcels and
// building facts:
//
//   1. one properties row per found appraiser parcel (county + parcel key)
//   2. observations from appraiser parcels fetched since the last run, and
//      from the building facts of every permit linked to a parcel
//   3. each multi-source field resolved by src/fields.js; a disagreement is a
//      field_conflicts row (auto_resolved by precedence, or open)
//
// Re-runnable without duplicates: observations are unique per entity, field,
// source, source record and value; a repeat of the current value writes
// nothing. A value that comes back after a change becomes current again.
//
//   node ingest/fields.js

const db = require('../db/index.js');
const F = require('../src/fields.js');

const CHUNK = 5000;

const countyValues = () => {
  const entries = Object.entries(F.APPRAISERS);
  return { providers: entries.map(([p]) => p), counties: entries.map(([, a]) => a.county) };
};

async function upsertProperties(client) {
  const { providers, counties } = countyValues();
  const { rowCount } = await client.query(`
    INSERT INTO properties (county, parcel_key)
    SELECT DISTINCT m.county, c.parcel_key
      FROM parcels c JOIN unnest($1::text[], $2::text[]) AS m(provider, county) ON m.provider = c.provider
     WHERE c.found
    ON CONFLICT (county, parcel_key) DO NOTHING`, [providers, counties]);
  return rowCount;
}

/** Insert observations; on a repeat, touch only a row that is not current. */
async function writeObservations(client, rows, sourceIds, runAt) {
  if (!rows.length) return 0;
  const col = (f) => rows.map(f);
  const { rowCount } = await client.query(`
    INSERT INTO field_observations (entity_type, entity_id, field, value, value_hash, source_id, source_ref, raw_record_id,
                                    method, confidence, source_as_of, retrieved_at, first_seen_at, last_seen_at, rule_version)
    SELECT 'property', t.e, t.f, t.v, t.h, t.s, t.r, t.rr, t.m, t.c, t.a, t.ra, $12, $12, $13
      FROM unnest($1::bigint[], $2::text[], $3::jsonb[], $4::text[], $5::bigint[], $6::text[], $7::bigint[], $8::text[],
                  $9::text[], $10::date[], $11::timestamptz[]) AS t(e, f, v, h, s, r, rr, m, c, a, ra)
    ON CONFLICT (entity_type, entity_id, field, source_id, source_ref, value_hash) DO UPDATE SET
      last_seen_at = EXCLUDED.last_seen_at, retrieved_at = EXCLUDED.retrieved_at, raw_record_id = EXCLUDED.raw_record_id
     WHERE field_observations.last_seen_at < (
       SELECT max(o.last_seen_at) FROM field_observations o
        WHERE o.entity_type = field_observations.entity_type AND o.entity_id = field_observations.entity_id
          AND o.field = field_observations.field AND o.source_id = field_observations.source_id
          AND o.source_ref = field_observations.source_ref)`,
  [col((r) => r.entityId), col((r) => r.field), col((r) => (r.value == null ? null : JSON.stringify(r.value))),
    col((r) => F.valueHash(r.value)), col((r) => sourceIds[r.sourceSlug]), col((r) => r.sourceRef), col((r) => r.rawRecordId),
    col((r) => r.method), col((r) => r.confidence), col((r) => r.sourceAsOf), col((r) => r.retrievedAt),
    runAt, F.RULE_VERSION]);
  return rowCount;
}

async function parcelPass(client, sourceIds, runAt) {
  let written = 0;
  let read = 0;
  for (const provider of Object.keys(F.APPRAISERS)) {
    if (!sourceIds[provider]) continue;
    // Parcels fetched since this provider's newest observation (all on the first run).
    const { rows: [{ since }] } = await client.query(
      "SELECT max(retrieved_at) AS since FROM field_observations WHERE entity_type = 'property' AND source_id = $1", [sourceIds[provider]]);
    let after = 0;
    for (;;) {
      const { rows } = await client.query(`
        SELECT c.*, pr.id AS property_id
          FROM parcels c JOIN properties pr ON pr.county = $2 AND pr.parcel_key = c.parcel_key
         WHERE c.provider = $1 AND c.found AND c.id > $3 AND ($4::timestamptz IS NULL OR c.fetched_at >= $4)
         ORDER BY c.id LIMIT $5`, [provider, F.APPRAISERS[provider].county, after, since, CHUNK]);
      if (!rows.length) break;
      after = Number(rows[rows.length - 1].id);
      read += rows.length;
      const obs = rows.flatMap((p) => F.parcelObservations(p).map((o) => ({ ...o, entityId: p.property_id })));
      written += await writeObservations(client, obs, sourceIds, runAt);
    }
  }
  return { read, written };
}

async function permitPass(client, sourceIds, runAt) {
  const { providers, counties } = countyValues();
  let written = 0;
  let read = 0;
  let after = 0;
  for (;;) {
    const { rows } = await client.query(`
      SELECT f.permit_id, f.units, f.floors, f.raw_record_id, f.extracted_at, p.permit_number, p.source_area AS source_slug,
             p.filed_date, pr.id AS property_id
        FROM permit_facts f
        JOIN permits p ON p.id = f.permit_id
        JOIN permit_parcels pp ON pp.permit_id = f.permit_id
        JOIN parcels c ON c.id = pp.parcel_id AND c.found
        JOIN unnest($1::text[], $2::text[]) AS m(provider, county) ON m.provider = c.provider
        JOIN properties pr ON pr.county = m.county AND pr.parcel_key = c.parcel_key
       WHERE (f.units IS NOT NULL OR f.floors IS NOT NULL) AND f.permit_id > $3
         -- A trade permit's units and floors describe its own job, not the
         -- building: only building permits speak for the property (fields-v2).
         AND EXISTS (SELECT 1 FROM permit_parties b WHERE b.permit_id = f.permit_id AND b.is_building)
       ORDER BY f.permit_id LIMIT $4`, [providers, counties, after, CHUNK]);
    if (!rows.length) break;
    after = Number(rows[rows.length - 1].permit_id);
    read += rows.length;
    const obs = rows.flatMap((r) => F.permitObservations(r).map((o) => ({ ...o, entityId: r.property_id })))
      .filter((o) => sourceIds[o.sourceSlug]);
    written += await writeObservations(client, obs, sourceIds, runAt);
  }
  return { read, written };
}

/**
 * Current observations of every property field that has more than one: the
 * newest row per source record, and a permit's only while that permit is
 * still linked to the property and is a building permit (fields-v2; a trade
 * permit's observations written under fields-v1 stay as history, unused).
 */
async function multiObservations(client) {
  const { providers, counties } = countyValues();
  const { rows } = await client.query(`
    WITH cur AS (
      SELECT DISTINCT ON (o.entity_id, o.field, o.source_id, o.source_ref) o.*
        FROM field_observations o WHERE o.entity_type = 'property'
       ORDER BY o.entity_id, o.field, o.source_id, o.source_ref, o.last_seen_at DESC, o.id DESC
    ), live AS (
      SELECT cur.id, cur.entity_id, cur.field, cur.value, cur.confidence, cur.source_ref, s.slug, s.role
        FROM cur JOIN sources s ON s.id = cur.source_id
       WHERE cur.value IS NOT NULL AND (s.role = 'enrichment' OR EXISTS (
         SELECT 1 FROM permits p
           JOIN permit_parcels pp ON pp.permit_id = p.id
           JOIN parcels c ON c.id = pp.parcel_id AND c.found
           JOIN unnest($1::text[], $2::text[]) AS m(provider, county) ON m.provider = c.provider
           JOIN properties pr ON pr.county = m.county AND pr.parcel_key = c.parcel_key
          WHERE p.source_area = s.slug AND p.permit_number = cur.source_ref AND pr.id = cur.entity_id
            AND EXISTS (SELECT 1 FROM permit_parties b WHERE b.permit_id = p.id AND b.is_building)))
    )
    SELECT l.* FROM live l
      JOIN (SELECT entity_id, field FROM live GROUP BY 1, 2 HAVING count(*) > 1) g USING (entity_id, field)
     ORDER BY l.entity_id, l.field, l.id`, [providers, counties]);
  return rows;
}

async function writeConflicts(client, conflicts) {
  const col = (f) => conflicts.map(f);
  await client.query('BEGIN');
  try {
    if (conflicts.length) {
      await client.query(`
        INSERT INTO field_conflicts (entity_type, entity_id, field, observation_ids, kind, status, resolution, rule_version)
        SELECT 'property', t.e, t.f, string_to_array(t.ids, ',')::bigint[], t.k, t.s, t.r, $7
          FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS t(e, f, ids, k, s, r)
        ON CONFLICT (entity_type, entity_id, field) DO UPDATE SET
          -- A person's review stands while the same observations are in conflict.
          status = CASE WHEN field_conflicts.status = 'reviewed' AND field_conflicts.observation_ids = EXCLUDED.observation_ids
                        THEN 'reviewed' ELSE EXCLUDED.status END,
          observation_ids = EXCLUDED.observation_ids, kind = EXCLUDED.kind, resolution = EXCLUDED.resolution,
          rule_version = EXCLUDED.rule_version, updated_at = now()`,
      [col((c) => c.entityId), col((c) => c.field), col((c) => c.observationIds.join(',')), col((c) => c.kind),
        col((c) => c.status), col((c) => c.resolution), F.RULE_VERSION]);
    }
    // A disagreement that no longer exists is not kept.
    const { rowCount: cleared } = await client.query(`
      DELETE FROM field_conflicts fc WHERE fc.entity_type = 'property'
         AND NOT EXISTS (SELECT 1 FROM unnest($1::bigint[], $2::text[]) AS t(e, f) WHERE t.e = fc.entity_id AND t.f = fc.field)`,
    [col((c) => c.entityId), col((c) => c.field)]);
    await client.query('COMMIT');
    return cleared;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function runFields() {
  const client = await db.getPool().connect();
  try {
    const [{ now: runAt }] = (await client.query('SELECT now()')).rows;
    const { rows: srcs } = await client.query('SELECT id, slug FROM sources');
    const sourceIds = Object.fromEntries(srcs.map((s) => [s.slug, Number(s.id)]));
    const properties = await upsertProperties(client);
    const parcels = await parcelPass(client, sourceIds, runAt);
    const permits = await permitPass(client, sourceIds, runAt);

    const groups = new Map();
    for (const o of await multiObservations(client)) {
      const k = `${o.entity_id}|${o.field}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ id: Number(o.id), entityId: Number(o.entity_id), field: o.field, value: o.value,
        role: o.role === 'enrichment' ? 'appraiser' : 'permit', confidence: o.confidence, sourceSlug: o.slug, sourceRef: o.source_ref });
    }
    const conflicts = [];
    for (const obs of groups.values()) {
      const r = F.resolve(obs[0].field, obs);
      if (r.conflict) conflicts.push({ entityId: obs[0].entityId, field: obs[0].field, ...r.conflict });
    }
    const cleared = await writeConflicts(client, conflicts);
    const byField = {};
    for (const c of conflicts) {
      const b = (byField[c.field] ||= { open: 0, auto_resolved: 0 });
      b[c.status] += 1;
    }
    return { properties, parcels, permits, multiFields: groups.size, conflicts: byField, cleared };
  } finally {
    client.release();
  }
}

async function main() {
  await db.applySchema();
  const s = await runFields();
  const lines = ['## Field observations', '',
    `New properties: ${s.properties}. Parcels read ${s.parcels.read}, observations written ${s.parcels.written}. `
    + `Permits with units/floors read ${s.permits.read}, observations written ${s.permits.written}.`,
    `Multi-source fields: ${s.multiFields}. Conflicts cleared: ${s.cleared}.`, '',
    '| field | open | auto-resolved |', '|---|---|---|',
    ...Object.entries(s.conflicts).map(([f, b]) => `| ${f} | ${b.open} | ${b.auto_resolved} |`)];
  console.log(lines.join('\n'));
  await db.close();
}

if (require.main === module) {
  main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
}

module.exports = { runFields };
