// Planning cases: store and link (migration 025, src/planning.js).
//
// ingest/run.js calls upsertPlanningCases for a source with kind 'planning'
// after its raw rows are stored, so every case points at the raw record it
// came from (rule 6). Re-runs write nothing new: cases upsert on (source,
// case number), parties on (case, role, name), and the status history only
// gains a row when the status, stage or the source's status date changes
// (trigger in 025).
//
// `node ingest/planning.js` rebuilds the links from cases to permits (each
// source's `planning.links` rules) and prints a report: cases by stage,
// unmapped statuses and case types (rule 3), and link rates.

const crypto = require('node:crypto');
const db = require('../db/index.js');
const { SOURCES } = require('../src/sources.js');
const { mapCase } = require('../src/planning.js');

const COLS = [
  ['caseNumber', 'case_number', 'text'], ['caseRef', 'case_ref', 'text'], ['caseType', 'case_type_raw', 'text'], ['caseKind', 'case_kind', 'text'],
  ['status', 'status_raw', 'text'], ['lifecycleStage', 'lifecycle_stage', 'text'],
  ['filedOn', 'filed_on', 'date'], ['statusDate', 'stage_since', 'date'], ['decidedOn', 'decided_on', 'date'], ['expiresOn', 'expires_on', 'date'],
  ['name', 'name', 'text'], ['description', 'description', 'text'], ['address', 'address_raw', 'text'], ['parcel', 'parcel_id', 'text'],
  ['propertyRef', 'property_ref', 'text'], ['officialRef', 'official_ref', 'text'], ['zoning', 'zoning', 'text'],
  ['unitsProposed', 'units_proposed', 'int'], ['unitsApproved', 'units_approved', 'int'],
  ['lotsProposed', 'lots_proposed', 'int'], ['lotsApproved', 'lots_approved', 'int'],
  ['floorAreaSqft', 'floor_area_sqft', 'int'], ['acreage', 'acreage', 'numeric'], ['flowGpd', 'flow_gpd', 'int'],
  ['lat', 'lat', 'float8'], ['lng', 'lng', 'float8'], ['recordUrl', 'record_url', 'text'],
];

/** Hash of the mapped case: a change in any stored attribute or party. */
function caseHash(c) {
  const v = COLS.map(([k]) => c[k] ?? null).concat([c.parties.map((p) => `${p.role}:${p.name}`).sort()]);
  return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
}

/**
 * Maps raw records (from ingest/raw.js toRawRecords) to cases and upserts
 * them. Returns counts. A row with no case number is counted as skipped.
 */
async function upsertPlanningCases(slug, sourceId, records, { client = db, batchSize = 500 } = {}) {
  const source = SOURCES[slug];
  const byNumber = new Map();
  let skipped = 0;
  for (const r of records) {
    const c = mapCase(source, r.payload);
    if (!c) { skipped += 1; continue; }
    // The same case twice in one run (overlapping windows): the last wins.
    byNumber.set(c.caseNumber, { ...c, contentHash: caseHash(c), sourceKey: r.sourceKey, payloadHash: r.payloadHash });
  }
  const cases = [...byNumber.values()];
  let inserted = 0; let changed = 0; let parties = 0;
  for (let i = 0; i < cases.length; i += batchSize) {
    const batch = cases.slice(i, i + batchSize);
    const json = JSON.stringify(batch.map((c) => Object.fromEntries([
      ...COLS.map(([k, col]) => [col, c[k] ?? null]),
      ['content_hash', c.contentHash], ['source_key', c.sourceKey], ['payload_hash', c.payloadHash],
    ])));
    const recordType = COLS.map(([, col, t]) => `${col} ${t}`).concat(['content_hash text', 'source_key text', 'payload_hash text']).join(', ');
    const cols = COLS.map(([, col]) => col);
    const { rows } = await client.query(`
      WITH input AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS t(${recordType})),
      up AS (
        INSERT INTO planning_cases (source_area, ${cols.join(', ')}, first_seen_stage, content_hash, latest_raw_record_id)
        SELECT $1, ${cols.map((c) => `i.${c}`).join(', ')}, i.lifecycle_stage, i.content_hash,
               (SELECT r.id FROM raw_records r WHERE r.source_id = $3 AND r.source_key = i.source_key AND r.payload_hash = i.payload_hash ORDER BY r.id DESC LIMIT 1)
          FROM input i
        ON CONFLICT (source_area, case_number) DO UPDATE SET
          ${cols.filter((c) => c !== 'case_number').map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
          latest_raw_record_id = COALESCE(EXCLUDED.latest_raw_record_id, planning_cases.latest_raw_record_id),
          content_hash = EXCLUDED.content_hash,
          last_seen_at = now(),
          updated_at = CASE WHEN planning_cases.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN now() ELSE planning_cases.updated_at END
        RETURNING id, case_number, (xmax = 0) AS inserted, updated_at = now() AS touched
      )
      SELECT * FROM up`, [slug, json, sourceId]);
    const idByNumber = new Map(rows.map((r) => [r.case_number, r.id]));
    inserted += rows.filter((r) => r.inserted).length;
    changed += rows.filter((r) => !r.inserted && r.touched).length;
    // Parties: the published set replaces the stored set for these cases.
    const ids = rows.map((r) => r.id);
    const p = batch.flatMap((c) => c.parties.map((x) => [idByNumber.get(c.caseNumber), x.role, x.name, x.partyKind]));
    await client.query('DELETE FROM planning_case_parties WHERE case_id = ANY($1::bigint[])', [ids]);
    if (p.length) {
      parties += (await client.query(`
        INSERT INTO planning_case_parties (case_id, role, name, party_kind)
        SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[]) ON CONFLICT DO NOTHING`,
      [p.map((x) => x[0]), p.map((x) => x[1]), p.map((x) => x[2]), p.map((x) => x[3])])).rowCount;
    }
  }
  return { cases: cases.length, inserted, changed, parties, skipped };
}

const planningSources = () => Object.entries(SOURCES).filter(([, s]) => s.kind === 'planning');

/**
 * Links rebuilt per rule, each declared in the source's `planning.links`:
 *   { kind, to, caseColumn, permitField, detail, days?, confidence? }
 * A permit's latest raw payload field `permitField` equals the case's
 * `caseColumn` (a planning_cases column).
 *   official: the source's own reference to that permit or case (Raleigh
 *     devplanid). Confidence 1.00.
 *   parcel_window: the same property or parcel, and the permit was submitted
 *     on or after the case was filed, within `days`. Inferred: a property can
 *     hold several projects, so it is never merged. Its confidence is the
 *     share of hand-checked pairs that were the same project (`measured`);
 *     a rule below the bar has `enabled: false` and writes no links.
 *   permitFilter { field, equals }: only permits whose latest raw payload
 *     field equals this (Raleigh: new construction only).
 */
const CASE_COLUMNS = new Set(['case_number', 'case_ref', 'official_ref', 'property_ref', 'parcel_id']);

async function rebuildLinks(client) {
  const out = {};
  for (const [slug, s] of planningSources()) {
    for (const l of (s.planning.links || [])) {
      if (!CASE_COLUMNS.has(l.caseColumn)) throw new Error(`${slug}: link caseColumn "${l.caseColumn}" is not allowed`);
      if (!['official', 'parcel_window'].includes(l.kind)) throw new Error(`${slug}: unknown link kind "${l.kind}"`);
      await client.query(`DELETE FROM planning_case_links k USING planning_cases c
        WHERE k.case_id = c.id AND c.source_area = $1 AND k.basis_detail = $2`, [slug, l.detail]);
      // A rule whose hand check failed writes nothing, and its old links are
      // gone (the delete above), so no screen can show them.
      if (l.enabled === false) { out[`${slug} -> ${l.to} (${l.detail})`] = `off: ${l.offReason}`; continue; }
      if (l.permitFilter && !/^[a-z_]+$/i.test(l.permitFilter.field)) throw new Error(`${slug}: bad permitFilter field`);
      const official = l.kind === 'official';
      const { rowCount } = await client.query(`
        WITH latest AS (
          SELECT DISTINCT ON (r.source_key) r.source_key, trim(r.payload ->> $3) AS k, r.payload
            FROM raw_records r JOIN sources s ON s.id = r.source_id
           WHERE s.slug = $2 AND nullif(trim(r.payload ->> $3), '') IS NOT NULL
           ORDER BY r.source_key, r.fetched_at DESC, r.id DESC)
        INSERT INTO planning_case_links (case_id, permit_id, link_basis, basis_detail, confidence)
        SELECT c.id, p.id, $5, $4, $6
          FROM planning_cases c
          JOIN latest x ON x.k = c.${l.caseColumn}
          JOIN permits p ON p.source_area = $2 AND p.permit_number = x.source_key
         WHERE c.source_area = $1
           AND ($8::text IS NULL OR lower(trim(x.payload ->> $8)) = lower($9))
           AND ($7::int IS NULL OR (c.filed_on IS NOT NULL
                AND COALESCE(p.submitted_on, p.filed_date) BETWEEN c.filed_on AND c.filed_on + $7::int))
        ON CONFLICT DO NOTHING`, [slug, l.to, l.permitField, l.detail,
        official ? 'official_reference' : 'parcel_window', official ? 1 : l.confidence, official ? null : l.days,
        l.permitFilter ? l.permitFilter.field : null, l.permitFilter ? l.permitFilter.equals : null]);
      out[`${slug} -> ${l.to} (${l.detail})`] = rowCount;
    }
  }
  return out;
}

async function report() {
  const slugs = planningSources().map(([s]) => s);
  const q = async (sql) => (await db.query(sql, [slugs])).rows;
  return {
    stages: await q(`SELECT source_area, lifecycle_stage, count(*)::int AS n FROM planning_cases
                      WHERE source_area = ANY($1::text[]) GROUP BY 1, 2 ORDER BY 1, n DESC`),
    unmapped: await q(`SELECT source_area, status_raw, count(*)::int AS n FROM planning_cases
                        WHERE source_area = ANY($1::text[]) AND lifecycle_stage = 'unknown' GROUP BY 1, 2 ORDER BY 1, n DESC`),
    otherKinds: await q(`SELECT source_area, case_type_raw, count(*)::int AS n FROM planning_cases
                          WHERE source_area = ANY($1::text[]) AND case_kind = 'other' GROUP BY 1, 2 ORDER BY 1, n DESC`),
    links: await q(`SELECT c.source_area, count(*)::int AS cases, count(DISTINCT k.case_id)::int AS linked,
                           percentile_disc(0.5) WITHIN GROUP (ORDER BY COALESCE(p.submitted_on, p.filed_date) - c.filed_on) AS median_days_to_permit
                      FROM planning_cases c LEFT JOIN planning_case_links k ON k.case_id = c.id LEFT JOIN permits p ON p.id = k.permit_id
                     WHERE c.source_area = ANY($1::text[]) GROUP BY 1 ORDER BY 1`),
  };
}

async function main() {
  await db.applySchema();
  const linked = await db.withTransaction(rebuildLinks);
  const r = await report();
  const lines = ['Planning cases:'];
  for (const [k, n] of Object.entries(linked)) lines.push(`- links ${k}: ${n}`);
  for (const l of r.links) lines.push(`- ${l.source_area}: ${l.cases} cases, ${l.linked} linked to a permit, median ${l.median_days_to_permit ?? 'n/a'} days case filed -> permit`);
  const group = (rows, col) => {
    const by = {};
    for (const x of rows) (by[x.source_area] ||= []).push(`${x[col] ?? '(none)'} ${x.n}`);
    return by;
  };
  for (const [s, list] of Object.entries(group(r.stages, 'lifecycle_stage'))) lines.push(`- stages, ${s}: ${list.join(', ')}`);
  for (const [s, list] of Object.entries(group(r.unmapped, 'status_raw'))) lines.push(`- unmapped statuses, ${s}: ${list.slice(0, 12).join(', ')}`);
  for (const [s, list] of Object.entries(group(r.otherKinds, 'case_type_raw'))) lines.push(`- unmapped case types, ${s}: ${list.slice(0, 12).join(', ')}`);
  console.log(lines.join('\n'));
  await db.close();
}

if (require.main === module) {
  main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
}

module.exports = { upsertPlanningCases, rebuildLinks, caseHash, planningSources };
