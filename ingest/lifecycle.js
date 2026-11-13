// Lifecycle run (ADR-16). Three steps, all re-runnable without duplicates:
//
//   1. Restage: apply each source's reviewed vocabulary (src/sources.js
//      `lifecycle`) to the permits and status history we already hold, so a
//      vocabulary fix in a pull request reaches old rows. No history row is
//      written: a fixed mapping is not a change to the permit.
//   2. Official dates: fill submitted_on and stage_since from the latest raw
//      payload where they are missing (rows from before migration 017).
//   3. Links: an Austin plan-review case leads to the building permit whose
//      masterpermitnum equals the case's folderrsn (an official reference,
//      docs/DATA_MODEL.md). Rebuilt each run from the latest raw payloads.
//
// It ends with a report: statuses no vocabulary maps (rule 3), the link rate
// and the lead time an application gives over the issued permit.
//
//   node ingest/lifecycle.js

const db = require('../db/index.js');
const { SOURCES } = require('../src/sources.js');
const { lifecycleStage } = require('../src/lifecycle.js');

const LINKS = [
  { from: 'austin-plan-review-tx', fromField: 'folderrsn', to: 'austin-tx', toField: 'masterpermitnum', detail: 'masterpermitnum = folderrsn' },
];

const withLifecycle = () => Object.entries(SOURCES).filter(([, s]) => s.lifecycle);

/** 1. Every (status_raw, status_stage) a source holds -> its stage, written where it differs. */
async function restage(client) {
  let permits = 0;
  let history = 0;
  for (const [slug, src] of withLifecycle()) {
    const { rows } = await client.query(`
      SELECT DISTINCT status_raw, status_stage FROM permits WHERE source_area = $1
      UNION SELECT DISTINCT h.status_raw, h.status_stage FROM permit_status_history h JOIN permits p ON p.id = h.permit_id WHERE p.source_area = $1`, [slug]);
    if (!rows.length) continue;
    const raw = rows.map((r) => r.status_raw);
    const derived = rows.map((r) => r.status_stage);
    const stage = rows.map((r) => lifecycleStage(src, r.status_raw, r.status_stage));
    const args = [slug, raw, derived, stage];
    const v = 'unnest($2::text[], $3::text[], $4::text[]) AS v(raw, derived, stage)';
    permits += (await client.query(`
      UPDATE permits p SET lifecycle_stage = v.stage FROM ${v}
       WHERE p.source_area = $1 AND p.status_raw IS NOT DISTINCT FROM v.raw AND p.status_stage IS NOT DISTINCT FROM v.derived
         AND p.lifecycle_stage IS DISTINCT FROM v.stage`, args)).rowCount;
    history += (await client.query(`
      UPDATE permit_status_history h SET lifecycle_stage = v.stage FROM permits p, ${v}
       WHERE p.id = h.permit_id AND p.source_area = $1
         AND h.status_raw IS NOT DISTINCT FROM v.raw AND h.status_stage IS NOT DISTINCT FROM v.derived
         AND h.lifecycle_stage IS DISTINCT FROM v.stage`, args)).rowCount;
  }
  return { permits, history };
}

// A raw value -> date, the way src/dates.js reads it: epoch milliseconds
// (ArcGIS) or a leading ISO date (Socrata). Anything else stays NULL.
const RAW_DATE = (f) => `CASE
  WHEN jsonb_typeof(r.payload -> ${f}) = 'number' THEN (to_timestamp((r.payload ->> ${f})::numeric / 1000) AT TIME ZONE 'UTC')::date
  WHEN pg_input_is_valid(substring(r.payload ->> ${f} from '^\\d{4}-\\d{2}-\\d{2}'), 'date')
    THEN substring(r.payload ->> ${f} from '^\\d{4}-\\d{2}-\\d{2}')::date END`;

/** 2. submitted_on / stage_since from the latest raw payload, where missing and the payload has the field. */
async function fillDates(client) {
  const out = { submittedOn: 0, stageSince: 0 };
  for (const [slug, src] of withLifecycle()) {
    for (const [mapKey, column, stat] of [['submittedDate', 'submitted_on', 'submittedOn'], ['statusDate', 'stage_since', 'stageSince']]) {
      const field = src.fieldMap && src.fieldMap[mapKey];
      if (!field) continue;
      out[stat] += (await client.query(`
        WITH latest AS (
          SELECT DISTINCT ON (r.source_key) p.id, ${RAW_DATE('$2')} AS d
            FROM permits p
            JOIN sources s ON s.slug = p.source_area
            JOIN raw_records r ON r.source_id = s.id AND r.source_key = p.permit_number
           WHERE p.source_area = $1 AND p.${column} IS NULL AND r.payload ->> $2 IS NOT NULL
           ORDER BY r.source_key, r.fetched_at DESC, r.id DESC)
        UPDATE permits p SET ${column} = latest.d FROM latest WHERE p.id = latest.id AND latest.d IS NOT NULL`, [slug, field])).rowCount;
    }
  }
  return out;
}

/** 3. Official-reference links, rebuilt per rule. */
async function link(client) {
  const out = {};
  for (const l of LINKS) {
    await client.query("DELETE FROM permit_links WHERE link_basis = 'official_reference' AND basis_detail = $1", [l.detail]);
    const { rowCount } = await client.query(`
      WITH latest AS (
        SELECT DISTINCT ON (r.source_id, r.source_key) s.slug, r.source_key, r.payload
          FROM raw_records r JOIN sources s ON s.id = r.source_id
         WHERE s.slug IN ($1, $3)
         ORDER BY r.source_id, r.source_key, r.fetched_at DESC, r.id DESC),
      a AS (SELECT p.id, trim(x.payload ->> $2) AS k FROM latest x JOIN permits p ON p.source_area = x.slug AND p.permit_number = x.source_key
             WHERE x.slug = $1 AND nullif(trim(x.payload ->> $2), '') IS NOT NULL),
      b AS (SELECT p.id, trim(x.payload ->> $4) AS k FROM latest x JOIN permits p ON p.source_area = x.slug AND p.permit_number = x.source_key
             WHERE x.slug = $3 AND nullif(trim(x.payload ->> $4), '') IS NOT NULL)
      INSERT INTO permit_links (from_permit_id, to_permit_id, link_basis, basis_detail, confidence)
      SELECT a.id, b.id, 'official_reference', $5, 1.00 FROM a JOIN b ON b.k = a.k
      ON CONFLICT DO NOTHING`, [l.from, l.fromField, l.to, l.toField, l.detail]);
    out[l.from] = rowCount;
  }
  return out;
}

/** Statuses no vocabulary maps, per source (rule 3), and per-link coverage and lead time. */
async function report() {
  const slugs = withLifecycle().map(([s]) => s);
  const { rows: unknown } = await db.query(`
    SELECT source_area, status_raw, count(*)::int AS n FROM permits
     WHERE source_area = ANY($1::text[]) AND lifecycle_stage = 'unknown'
     GROUP BY 1, 2 ORDER BY 1, n DESC`, [slugs]);
  const links = [];
  for (const l of LINKS) {
    const [r] = (await db.query(`
      SELECT
        (SELECT count(*)::int FROM permits WHERE source_area = $1) AS applications,
        (SELECT count(*)::int FROM permits WHERE source_area = $1 AND lifecycle_stage = 'approved') AS approved,
        count(DISTINCT k.from_permit_id)::int AS linked_applications,
        count(DISTINCT k.to_permit_id)::int AS linked_permits,
        (SELECT count(*)::int FROM permits WHERE source_area = $2 AND filed_date >= (SELECT min(submitted_on) FROM permits WHERE source_area = $1)
            AND permit_number LIKE '% BP') AS building_permits_since,
        percentile_disc(0.5) WITHIN GROUP (ORDER BY t.filed_date - f.submitted_on) AS median_days_submitted_to_issued,
        percentile_disc(0.5) WITHIN GROUP (ORDER BY t.first_seen_at::date - f.first_seen_at::date) AS median_days_seen_earlier
        FROM permit_links k JOIN permits f ON f.id = k.from_permit_id JOIN permits t ON t.id = k.to_permit_id
       WHERE k.basis_detail = $3`, [l.from, l.to, l.detail])).rows;
    links.push({ ...l, ...r });
  }
  return { unknown, links };
}

async function runLifecycle() {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const restaged = await restage(client);
    const dates = await fillDates(client);
    const linked = await link(client);
    await client.query('COMMIT');
    // A large restage (the first run after 017 touches every permit) leaves
    // dead rows; make their space reusable now rather than growing the
    // database before autovacuum gets there (Neon storage is capped).
    if (restaged.permits + restaged.history + dates.submittedOn + dates.stageSince > 10000) {
      await client.query('VACUUM (ANALYZE) permits, permit_status_history');
    }
    return { restaged, dates, linked, ...(await report()) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  await db.applySchema();
  const s = await runLifecycle();
  const lines = [`Lifecycle: ${s.restaged.permits} permits and ${s.restaged.history} history rows restaged; `
    + `${s.dates.submittedOn} submission dates and ${s.dates.stageSince} status dates filled from raw records.`];
  for (const l of s.links) {
    lines.push(`${l.from} -> ${l.to} (${l.detail}): ${l.linked_applications} of ${l.applications} applications linked `
      + `(${l.approved} at approved), to ${l.linked_permits} permits (${l.building_permits_since} building permits issued since the first application we hold). `
      + `Median ${l.median_days_submitted_to_issued ?? 'n/a'} days from submission to issue; seen a median ${l.median_days_seen_earlier ?? 'n/a'} days earlier.`);
  }
  const bySource = {};
  for (const u of s.unknown) (bySource[u.source_area] ||= []).push(`${u.status_raw ?? '(none)'} ${u.n}`);
  for (const [src, list] of Object.entries(bySource)) lines.push(`Unmapped statuses, ${src}: ${list.slice(0, 10).join(', ')}${list.length > 10 ? ', ...' : ''}`);
  console.log(lines.join('\n\n'));
  await db.close();
}

if (require.main === module) {
  main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
}

module.exports = { runLifecycle, LINKS };
