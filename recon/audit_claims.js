// Read-only checks of the claims in the external audit (2026-11-15) against
// the live database: duplicate keys, near-duplicate permit numbers, tables
// without a natural key, permit indexes and the plans of the searches the
// audit called slow, pre-issue rows per market, sync failures and truncation,
// parcel links. Prints Markdown with counts only, never names or phones.
//
//   DATABASE_URL=... node recon/audit_claims.js

const db = require('../db/index.js');

db.getPool().on('connect', (c) => {
  c.query("SET default_transaction_read_only = on; SET statement_timeout = '120s'").catch(() => {});
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

async function main() {
  out(`# Audit claim checks, ${new Date().toISOString()}`); out();

  await section('Idempotency: duplicate natural keys', async () => {
    const exact = await q(`SELECT source_area, count(*)::int AS rows,
        count(*) - count(DISTINCT permit_number) AS exact_dups,
        count(*) - count(DISTINCT upper(regexp_replace(permit_number, '[^A-Za-z0-9]', '', 'g'))) AS near_dups
      FROM permits GROUP BY 1 ORDER BY 1`);
    table(['market', 'rows', 'exact duplicate keys', 'keys equal after dropping case/punctuation'],
      exact.map((r) => [r.source_area, r.rows, r.exact_dups, r.near_dups]));
    const pc = await q(`SELECT source_area, count(*)::int AS n, count(*) - count(DISTINCT case_number) AS dups FROM planning_cases GROUP BY 1 ORDER BY 1`);
    table(['planning source', 'cases', 'duplicate case numbers'], pc.map((r) => [r.source_area, r.n, r.dups]));
    const raw = await q(`SELECT count(*)::int AS n FROM (SELECT source_id, source_key, payload_hash FROM raw_records GROUP BY 1,2,3 HAVING count(*) > 1) x`);
    out(`raw_records with the same (source, key, payload hash) more than once: ${raw[0].n}`); out();
  });

  await section('Tables with no primary key or unique index', async () => {
    const rows = await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND (i.indisprimary OR i.indisunique))
       ORDER BY 1`);
    out(rows.length ? rows.map((r) => `- ${r.relname}`).join('\n') : 'None.'); out();
  });

  await section('Indexes on permits and permit_parties', async () => {
    const rows = await q(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE tablename IN ('permits','permit_parties') ORDER BY 1, 2`);
    table(['table', 'index', 'definition'], rows.map((r) => [r.tablename, r.indexname, r.indexdef.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ /, '$1')]));
  });

  await section('Query plans for the searches the audit called unindexed', async () => {
    const plans = {
      'contractor name contains (search screen)': `SELECT id FROM permits WHERE contractor_name ILIKE '%builders%' AND status_stage = ANY('{pending,approved}') ORDER BY filed_date DESC LIMIT 50`,
      'recent permits by stage (search screen default)': `SELECT id FROM permits WHERE status_stage = ANY('{pending,approved}') ORDER BY filed_date DESC LIMIT 50`,
      'issued in the last 7 days, one market (weekly list)': `SELECT p.id FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id WHERE p.source_area = 'austin-tx' AND pp.issued_on >= current_date - 7 LIMIT 500`,
      'status filter, one market': `SELECT count(*) FROM permits WHERE source_area = 'austin-tx' AND lifecycle_stage = 'in_review'`,
    };
    const rows = [];
    for (const [name, sql] of Object.entries(plans)) {
      const r = await q(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`);
      const plan = r[0]['QUERY PLAN'][0];
      const nodes = []; const walk = (n) => { nodes.push(n['Node Type'] + (n['Index Name'] ? ` ${n['Index Name']}` : '') + (n['Relation Name'] && !n['Index Name'] ? ` ${n['Relation Name']}` : '')); (n.Plans || []).forEach(walk); };
      walk(plan.Plan);
      rows.push([name, `${plan['Execution Time'].toFixed(1)} ms`, nodes.join(' > ')]);
    }
    table(['query', 'time', 'plan'], rows);
  });

  await section('Pre-issue rows per market (lifecycle_stage)', async () => {
    const rows = await q(`SELECT source_area, lifecycle_stage, count(*)::int AS n FROM permits GROUP BY 1, 2 ORDER BY 1, 3 DESC`);
    table(['market', 'lifecycle stage', 'rows'], rows.map((r) => [r.source_area, r.lifecycle_stage, r.n]));
    const pc = await q(`SELECT source_area, count(*)::int AS n FROM planning_cases GROUP BY 1 ORDER BY 1`);
    table(['planning source', 'cases'], pc.map((r) => [r.source_area, r.n]));
  });

  await section('Sync attempts, last 30 days', async () => {
    const rows = await q(`SELECT s.slug, r.status, coalesce(r.error_class, '') AS error_class, count(*)::int AS n
        FROM sync_runs r JOIN sources s ON s.id = r.source_id WHERE r.started_at > now() - interval '30 days'
       GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
    table(['source', 'status', 'error class', 'runs'], rows.map((r) => [r.slug, r.status, r.error_class, r.n]));
    const ev = await q(`SELECT s.slug, e.kind, count(*)::int AS n, max(e.created_at) AS last FROM source_events e JOIN sources s ON s.id = e.source_id
       WHERE e.created_at > now() - interval '30 days' GROUP BY 1, 2 ORDER BY 1, 2`);
    table(['source', 'event', 'count', 'last'], ev.map((r) => [r.slug, r.kind, r.n, r.last && r.last.toISOString().slice(0, 16)]));
    const stuck = await q(`SELECT count(*)::int AS n FROM sync_runs WHERE status = 'running' AND started_at < now() - interval '6 hours'`);
    out(`Runs still 'running' after 6 hours: ${stuck[0].n}`); out();
  });

  await section('Parcel links per market', async () => {
    const rows = await q(`SELECT p.source_area, count(*)::int AS permits,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM permit_parcels pp WHERE pp.permit_id = p.id))::int AS with_parcel,
        count(*) FILTER (WHERE nullif(trim(p.parcel_number), '') IS NOT NULL)::int AS source_parcel_field
      FROM permits p GROUP BY 1 ORDER BY 1`);
    table(['market', 'permits', 'linked to a parcels row', 'source gives a parcel number'], rows.map((r) => [r.source_area, r.permits, r.with_parcel, r.source_parcel_field]));
  });

  await section('Contractor identity', async () => {
    const rows = await q(`SELECT split_part(identity_key, ':', 1) AS key_type, coalesce(business_state, '') AS state, count(*)::int AS n FROM contractors GROUP BY 1, 2 ORDER BY 2, 1`);
    table(['key type', 'state', 'contractors'], rows.map((r) => [r.key_type, r.state, r.n]));
    const al = await q(`SELECT count(*)::int AS aliases, count(DISTINCT contractor_id)::int AS contractors FROM contractor_aliases`);
    out(`Raw-name aliases folded into contractors: ${al[0].aliases} aliases on ${al[0].contractors} contractors`); out();
  });

  await db.close();
}

main().catch(async (err) => { console.error(err); await db.close(); process.exit(1); });
