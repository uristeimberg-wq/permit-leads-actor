// Inspections: store, link and report (migration 033, src/inspections.js).
//
// ingest/run.js calls upsertInspections for a source with kind 'inspections'
// after its raw rows are stored, so every inspection points at the raw record
// it came from (rule 6). Re-runs write nothing new: inspections upsert on
// (source, inspection key) and the result history only gains a row when the
// result wording or the completed flag changes (trigger in 033).
//
// `node ingest/inspections.js` sets each inspection's permit from the
// source's own permit number and prints a report: inspections by result
// class, wordings not in the vocabulary (rule 3), link rates and result
// changes recorded.

const crypto = require('node:crypto');
const db = require('../db/index.js');
const { SOURCES } = require('../src/sources.js');
const { mapInspection } = require('../src/inspections.js');

const COLS = [
  ['inspectionKey', 'inspection_key', 'text'], ['permitNumber', 'permit_number', 'text'], ['permitType', 'permit_type_raw', 'text'],
  ['inspectionType', 'inspection_type_raw', 'text'], ['result', 'result_raw', 'text'], ['resultClass', 'result_class', 'text'],
  ['completed', 'completed', 'boolean'], ['scheduledOn', 'scheduled_on', 'date'], ['address', 'address_raw', 'text'],
];

function inspectionHash(x) {
  return crypto.createHash('sha256').update(JSON.stringify(COLS.map(([k]) => x[k] ?? null))).digest('hex');
}

/** Maps raw records to inspections; the same key twice in one run keeps the last. Pure. */
function toInspections(slug, records) {
  const source = SOURCES[slug];
  const byKey = new Map();
  let skipped = 0;
  for (const r of records) {
    const x = mapInspection(source, r.payload);
    if (!x) { skipped += 1; continue; }
    byKey.set(x.inspectionKey, { ...x, contentHash: inspectionHash(x), sourceKey: r.sourceKey, payloadHash: r.payloadHash });
  }
  return { inspections: [...byKey.values()], skipped };
}

async function upsertInspections(slug, sourceId, records, { client = db, batchSize = 1000 } = {}) {
  const { inspections, skipped } = toInspections(slug, records);
  let inserted = 0; let changed = 0;
  const cols = COLS.map(([, c]) => c);
  const recordType = COLS.map(([, c, t]) => `${c} ${t}`).concat(['content_hash text', 'source_key text', 'payload_hash text']).join(', ');
  for (let i = 0; i < inspections.length; i += batchSize) {
    const batch = inspections.slice(i, i + batchSize);
    const json = JSON.stringify(batch.map((x) => Object.fromEntries([
      ...COLS.map(([k, c]) => [c, x[k] ?? null]),
      ['content_hash', x.contentHash], ['source_key', x.sourceKey], ['payload_hash', x.payloadHash],
    ])));
    const { rows } = await client.query(`
      WITH input AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS t(${recordType}))
      INSERT INTO inspections (source_area, ${cols.join(', ')}, content_hash, latest_raw_record_id)
      SELECT $1, ${cols.map((c) => `i.${c}`).join(', ')}, i.content_hash,
             (SELECT r.id FROM raw_records r WHERE r.source_id = $3 AND r.source_key = i.source_key AND r.payload_hash = i.payload_hash ORDER BY r.id DESC LIMIT 1)
        FROM input i
      ON CONFLICT (source_area, inspection_key) DO UPDATE SET
        ${cols.filter((c) => c !== 'inspection_key').map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
        latest_raw_record_id = COALESCE(EXCLUDED.latest_raw_record_id, inspections.latest_raw_record_id),
        content_hash = EXCLUDED.content_hash,
        last_seen_at = now(),
        updated_at = CASE WHEN inspections.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN now() ELSE inspections.updated_at END
      RETURNING (xmax = 0) AS inserted, updated_at = now() AS touched`, [slug, json, sourceId]);
    inserted += rows.filter((r) => r.inserted).length;
    changed += rows.filter((r) => !r.inserted && r.touched).length;
  }
  return { inspections: inspections.length, inserted, changed, skipped };
}

const inspectionSources = () => Object.entries(SOURCES).filter(([, s]) => s.kind === 'inspections');

/**
 * permit_id from the source's own permit number, guarded by the house number.
 * The number alone named a permit at another address in 8 of 150 Miami-Dade
 * pairs and 1 of 150 Raleigh pairs (recon/lifecycle_scan.js, 2026-11-15), so
 * a link also needs the first address token (the house number) to agree. A
 * link that no longer holds is cleared.
 */
async function linkPermits(client) {
  const out = {};
  for (const [slug, s] of inspectionSources()) {
    const { rowCount } = await client.query(`
      WITH m AS (
        SELECT i.id, p.id AS permit_id
          FROM inspections i
          JOIN permits p ON p.source_area = $2 AND p.permit_number = i.permit_number
         WHERE i.source_area = $1
           AND split_part(trim(i.address_raw), ' ', 1) ~ '^[0-9]+$'
           AND split_part(trim(i.address_raw), ' ', 1) = split_part(trim(p.address), ' ', 1))
      UPDATE inspections i SET permit_id = m.permit_id
        FROM inspections i2 LEFT JOIN m ON m.id = i2.id
       WHERE i.id = i2.id AND i.source_area = $1 AND i.permit_id IS DISTINCT FROM m.permit_id`, [slug, s.inspections.link.to]);
    out[`${slug} -> ${s.inspections.link.to}`] = rowCount;
  }
  return out;
}

async function report() {
  const slugs = inspectionSources().map(([s]) => s);
  const q = async (sql) => (await db.query(sql, [slugs])).rows;
  return {
    classes: await q(`SELECT source_area, result_class, count(*)::int AS n FROM inspections
                       WHERE source_area = ANY($1::text[]) GROUP BY 1, 2 ORDER BY 1, n DESC`),
    unmapped: await q(`SELECT source_area, result_raw, count(*)::int AS n FROM inspections
                        WHERE source_area = ANY($1::text[]) AND result_class = 'unknown' GROUP BY 1, 2 ORDER BY 1, n DESC`),
    links: await q(`SELECT source_area, count(*)::int AS inspections, count(permit_id)::int AS linked,
                           count(DISTINCT permit_number)::int AS permits
                      FROM inspections WHERE source_area = ANY($1::text[]) GROUP BY 1 ORDER BY 1`),
    changes: await q(`SELECT i.source_area, count(*)::int AS changes
                        FROM inspection_result_history h JOIN inspections i ON i.id = h.inspection_id
                       WHERE i.source_area = ANY($1::text[]) AND h.observed_at > i.first_seen_at + interval '1 minute'
                       GROUP BY 1 ORDER BY 1`),
  };
}

async function main() {
  await db.applySchema();
  const linked = await db.withTransaction(linkPermits);
  const r = await report();
  const lines = ['Inspections:'];
  for (const [k, n] of Object.entries(linked)) lines.push(`- permit links set ${k}: ${n}`);
  for (const l of r.links) lines.push(`- ${l.source_area}: ${l.inspections} inspections on ${l.permits} permit numbers, ${l.linked} linked to a permit we hold`);
  for (const c of r.changes) lines.push(`- ${c.source_area}: ${c.changes} result changes recorded after first sight`);
  const by = {};
  for (const x of r.classes) (by[x.source_area] ||= []).push(`${x.result_class} ${x.n}`);
  for (const [s, list] of Object.entries(by)) lines.push(`- results, ${s}: ${list.join(', ')}`);
  const un = {};
  for (const x of r.unmapped) (un[x.source_area] ||= []).push(`${x.result_raw ?? '(none)'} ${x.n}`);
  for (const [s, list] of Object.entries(un)) lines.push(`- unmapped results, ${s}: ${list.slice(0, 12).join(', ')}`);
  console.log(lines.join('\n'));
  await db.close();
}

if (require.main === module) {
  main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
}

module.exports = { upsertInspections, toInspections, linkPermits, inspectionHash, inspectionSources, report };
