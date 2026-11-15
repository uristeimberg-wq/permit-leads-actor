// Read-only verification of the data-engine hardening against the live
// database (docs/research/2026-11-15-engine-gap-analysis.md). One section per
// brief phase; a section whose objects are not migrated yet says so instead
// of failing. Prints Markdown with counts only, never names or phones.
//
//   DATABASE_URL=... node recon/engine_verify.js

const db = require('../db/index.js');
const { STAGES } = require('../src/lifecycle.js');

db.getPool().on('connect', (c) => {
  c.query("SET default_transaction_read_only = on; SET statement_timeout = '180s'").catch(() => {});
});

const q = async (sql, p) => (await db.query(sql, p)).rows;
const out = (s = '') => process.stdout.write(`${s}\n`);
const table = (head, rows) => {
  out(`| ${head.join(' | ')} |`);
  out(`|${head.map(() => '---').join('|')}|`);
  for (const r of rows) out(`| ${r.map((x) => (x == null ? '' : String(x).replace(/\|/g, '/'))).join(' | ')} |`);
  out();
};
async function section(title, fn) {
  out(`## ${title}`); out();
  try { await fn(); } catch (err) { out(`_Section failed: ${err.code || ''} ${err.message}_`); out(); }
}
const exists = async (name) => (await q('SELECT to_regclass($1) IS NOT NULL AS ok', [name]))[0].ok;
const hasColumn = async (t, c) => (await q(
  'SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = $1 AND column_name = $2', [t, c]))[0].n > 0;
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '');

// The brief's eight phases, same as lifecycle_phase() in migration 035, so
// this runs before the migration too.
const PHASE_SQL = (col) => `CASE ${col}
  WHEN 'pre_application' THEN 'pre_application' WHEN 'submitted' THEN 'application_submitted'
  WHEN 'in_review' THEN 'plan_review' WHEN 'corrections' THEN 'plan_review' WHEN 'approved' THEN 'approved'
  WHEN 'issued' THEN 'issued' WHEN 'inspections' THEN 'inspection' WHEN 'completed' THEN 'finaled'
  WHEN 'expired' THEN 'expired_or_withdrawn' WHEN 'withdrawn' THEN 'expired_or_withdrawn'
  WHEN 'cancelled' THEN 'expired_or_withdrawn' WHEN 'denied' THEN 'expired_or_withdrawn' ELSE 'unknown' END`;
const PHASES = ['pre_application', 'application_submitted', 'plan_review', 'approved', 'issued', 'inspection', 'finaled', 'expired_or_withdrawn', 'unknown'];

async function main() {
  const [{ v }] = await q('SELECT max(version)::int AS v FROM schema_migrations');
  out(`# Data-engine verification, ${new Date().toISOString()}`); out();
  out(`Schema version: ${v}. Read-only connection.`); out();

  // --- Phase 1 --------------------------------------------------------------
  await section('Phase 1: duplicate natural keys (must all be 0)', async () => {
    const rows = await q(`
      SELECT 'permits (source_area, permit_number)' AS k, count(*)::int AS n FROM (SELECT 1 FROM permits GROUP BY source_area, permit_number HAVING count(*) > 1) x
      UNION ALL SELECT 'planning_cases (source_area, case_number)', count(*)::int FROM (SELECT 1 FROM planning_cases GROUP BY source_area, case_number HAVING count(*) > 1) x
      UNION ALL SELECT 'inspections (source_area, inspection_key)', count(*)::int FROM (SELECT 1 FROM inspections GROUP BY source_area, inspection_key HAVING count(*) > 1) x
      UNION ALL SELECT 'raw_records (source, key, payload hash)', count(*)::int FROM (SELECT 1 FROM raw_records GROUP BY source_id, source_key, payload_hash HAVING count(*) > 1) x`);
    table(['natural key', 'duplicate groups'], rows.map((r) => [r.k, r.n]));
  });

  await section('Phase 1: raw payload preservation', async () => {
    const withUrl = await hasColumn('raw_records', 'source_url');
    const rows = await q(`
      SELECT s.slug, count(*)::int AS n, count(DISTINCT r.source_key)::int AS keys,
             count(r.source_updated_at)::int AS upd, ${withUrl ? 'count(r.source_url)::int' : 'NULL::int'} AS url,
             max(r.fetched_at) AS last_fetch
        FROM raw_records r JOIN sources s ON s.id = r.source_id GROUP BY 1 ORDER BY 1`);
    table(['source', 'raw rows', 'distinct records', 'with source_updated_at', 'with source_url', 'last fetched'],
      rows.map((r) => [r.slug, r.n, r.keys, `${r.upd} (${pct(r.upd, r.n)})`, withUrl ? `${r.url} (${pct(r.url, r.n)})` : 'column not migrated', r.last_fetch && r.last_fetch.toISOString().slice(0, 16)]));
    // Every stored permit of a raw-captured source should have a raw record.
    const orphan = await q(`
      SELECT p.source_area, count(*)::int AS n,
             count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM raw_records r WHERE r.source_id = s.id AND r.source_key = p.permit_number))::int AS no_raw
        FROM permits p JOIN sources s ON s.slug = p.source_area
       WHERE s.kind IN ('socrata', 'arcgis') GROUP BY 1 ORDER BY 1`);
    table(['market', 'permits', 'without a raw record'], orphan.map((r) => [r.source_area, r.n, `${r.no_raw} (${pct(r.no_raw, r.n)})`]));
  });

  await section('Phase 1: lifecycle stages', async () => {
    const bad = await q(`
      SELECT 'permits' AS t, lifecycle_stage, count(*)::int AS n FROM permits WHERE NOT (lifecycle_stage = ANY($1)) GROUP BY 1, 2
      UNION ALL SELECT 'planning_cases', lifecycle_stage, count(*)::int FROM planning_cases WHERE NOT (lifecycle_stage = ANY($1)) GROUP BY 1, 2`, [STAGES]);
    out(`Rows outside the vocabulary (the 035 CHECK is NOT VALID until these are 0): ${bad.length ? bad.map((b) => `${b.t}.${b.lifecycle_stage} ${b.n}`).join(', ') : '0'}`); out();
    const rows = await q(`SELECT source_area, ${PHASE_SQL('lifecycle_stage')} AS phase, count(*)::int AS n FROM permits GROUP BY 1, 2`);
    const by = new Map();
    for (const r of rows) { if (!by.has(r.source_area)) by.set(r.source_area, {}); by.get(r.source_area)[r.phase] = r.n; }
    table(['market', ...PHASES, 'pre-approval share'], [...by].sort().map(([m, c]) => {
      const total = Object.values(c).reduce((a, b) => a + b, 0);
      const pre = (c.pre_application || 0) + (c.application_submitted || 0) + (c.plan_review || 0) + (c.approved || 0);
      return [m, ...PHASES.map((p) => c[p] || 0), pct(pre, total)];
    }));
    const pc = await q(`SELECT source_area, ${PHASE_SQL('lifecycle_stage')} AS phase, count(*)::int AS n FROM planning_cases GROUP BY 1, 2`);
    const byc = new Map();
    for (const r of pc) { if (!byc.has(r.source_area)) byc.set(r.source_area, {}); byc.get(r.source_area)[r.phase] = r.n; }
    table(['planning source', ...PHASES], [...byc].sort().map(([m, c]) => [m, ...PHASES.map((p) => c[p] || 0)]));
  });

  await section('Phase 1: status changelog', async () => {
    const rows = await q(`
      SELECT 'permit_status_history' AS t, count(*)::int AS n, count(*) FILTER (WHERE observed_at > now() - interval '7 days')::int AS week FROM permit_status_history
      UNION ALL SELECT 'planning_case_status_history', count(*)::int, count(*) FILTER (WHERE observed_at > now() - interval '7 days')::int FROM planning_case_status_history
      UNION ALL SELECT 'inspection_result_history', count(*)::int, count(*) FILTER (WHERE observed_at > now() - interval '7 days')::int FROM inspection_result_history`);
    table(['history table', 'rows', 'last 7 days'], rows.map((r) => [r.t, r.n, r.week]));
    if (await exists('record_status_changelog')) {
      const ch = await q(`SELECT record_type, field_changed, count(*)::int AS n FROM record_status_changelog
                           WHERE old_value IS NOT NULL AND detected_at > now() - interval '7 days' GROUP BY 1, 2 ORDER BY 1, 2`);
      table(['record', 'field', 'transitions in 7 days'], ch.map((r) => [r.record_type, r.field_changed, r.n]));
      const trig = await q(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE '%_append_only'`);
      out(`Append-only triggers installed: ${trig[0].n} of 3.`); out();
    } else { out('_record_status_changelog not migrated yet (035)._'); out(); }
  });

  await section('Phase 1: watermarks and connector health', async () => {
    if (await exists('source_watermarks')) {
      const w = await q(`SELECT s.slug, w.window_field, w.last_successful_sync_at, w.high_water_value
                           FROM source_watermarks w JOIN sources s ON s.id = w.source_id ORDER BY 1, 2`);
      table(['source', 'window', 'last successful sync', 'newest source date seen'],
        w.map((r) => [r.slug, r.window_field, r.last_successful_sync_at.toISOString().slice(0, 16), r.high_water_value && r.high_water_value.toISOString().slice(0, 10)]));
    } else { out('_source_watermarks not migrated yet (035)._'); out(); }
    const view = (await exists('connector_health_logs')) ? 'connector_health_logs' : null;
    const rows = view
      ? await q(`SELECT source, alert, severity, count(*)::int AS n FROM connector_health_logs WHERE logged_at > now() - interval '7 days' GROUP BY 1, 2, 3 ORDER BY 1, 2`)
      : await q(`SELECT s.slug AS source, e.kind AS alert, e.severity, count(*)::int AS n FROM source_events e JOIN sources s ON s.id = e.source_id
                  WHERE e.created_at > now() - interval '7 days' GROUP BY 1, 2, 3 ORDER BY 1, 2`);
    out(view ? 'From connector_health_logs, last 7 days:' : 'From source_events (connector_health_logs not migrated yet), last 7 days:'); out();
    table(['source', 'alert', 'severity', 'count'], rows.map((r) => [r.source, r.alert, r.severity, r.n]));
  });

  await section('Phase 1: indexes the brief names', async () => {
    const want = ['permits_lifecycle', 'planning_cases_stage', 'permits_first_seen', 'raw_records_fetched', 'raw_records_source_updated',
      'permit_parcels_parcel', 'planning_cases_parcel', 'permits_parcel_number', 'permit_parties_contractor', 'contractor_registry_licences_licence'];
    const have = new Set((await q('SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)', [want])).map((r) => r.indexname));
    table(['index', 'present'], want.map((n) => [n, have.has(n) ? 'yes' : 'no']));
  });

  await db.close();
}

main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
