// Read-only audit of the displayed "declared value" (permits.valuation) in
// every market and record type. For each source: which raw column supplied the
// value, its distribution, implausible values, and permit types. Prints
// Markdown, counts only.
//
//   DATABASE_URL=... node recon/value_audit.js

const db = require('../db/index.js');
const { SOURCES } = require('../src/sources.js');

db.getPool().on('connect', (c) => {
  c.query("SET default_transaction_read_only = on; SET statement_timeout = '300s'").catch(() => {});
});
const q = async (sql, p) => (await db.query(sql, p)).rows;
const out = (s = '') => process.stdout.write(`${s}\n`);
const table = (head, rows) => {
  out(`| ${head.join(' | ')} |`);
  out(`|${head.map(() => '---').join('|')}|`);
  for (const r of rows) out(`| ${r.map((x) => (x == null ? '' : String(x).replace(/\|/g, '/'))).join(' | ')} |`);
  out();
};
const money = (v) => (v == null ? '' : `$${Math.round(Number(v)).toLocaleString('en-US')}`);

async function main() {
  const slugs = ['austin-tx', 'austin-plan-review-tx', 'miami-dade-fl', 'miami-city-fl', 'raleigh-nc'];
  out('## Declared value by source');
  out();
  const summary = await q(`
    SELECT source_area, count(*)::int AS n, count(valuation)::int AS valued,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY valuation) AS median,
           percentile_cont(0.99) WITHIN GROUP (ORDER BY valuation) AS p99, max(valuation) AS max,
           count(*) FILTER (WHERE valuation > 0 AND valuation < 100)::int AS under100,
           count(*) FILTER (WHERE valuation >= 100000000)::int AS over100m
      FROM permits WHERE source_area = ANY($1) GROUP BY 1 ORDER BY 1`, [slugs]);
  table(['Source', 'Records', 'With a value', 'Median', 'p99', 'Max', 'Under $100', '$100M+'],
    summary.map((r) => [r.source_area, r.n, r.valued, money(r.median), money(r.p99), money(r.max), r.under100, r.over100m]));

  // Which raw column the shown value came from (the first non-empty one in
  // the source's fieldMap list), for sources that map several.
  for (const slug of slugs) {
    const cols = [].concat(SOURCES[slug].fieldMap.valuation);
    out(`### ${slug}: mapped column${cols.length > 1 ? 's (first non-empty wins)' : ''}: ${cols.join(', ')}`);
    out();
    const pick = `CASE ${cols.map((c) => `WHEN nullif(trim(r.payload->>'${c}'), '') IS NOT NULL AND (CASE WHEN (r.payload->>'${c}') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (r.payload->>'${c}')::numeric END) <> 0 THEN '${c}'`).join(' ')} ELSE NULL END`;
    const rows = await q(`
      WITH latest AS (
        SELECT DISTINCT ON (p.id) p.id, p.valuation, p.permit_type, p.filing_kind, r.payload
          FROM permits p JOIN sources s ON s.slug = p.source_area
          JOIN raw_records r ON r.source_id = s.id AND r.source_key = p.permit_number
         WHERE p.source_area = $1
         ORDER BY p.id, r.id DESC)
      SELECT ${pick} AS col, count(*)::int AS n, count(valuation)::int AS valued,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY valuation) AS median, max(valuation) AS max
        FROM latest r GROUP BY 1 ORDER BY 2 DESC`, [slug]);
    table(['Column that supplied the value', 'Records', 'Shown with a value', 'Median', 'Max'],
      rows.map((r) => [r.col || '(none)', r.n, r.valued, money(r.median), money(r.max)]));
    if (cols.length > 1) {
      // Rows where the total is empty but a component is not: what we show is
      // one trade's or one part's value, not the job's.
      const comp = await q(`
        WITH latest AS (
          SELECT DISTINCT ON (p.id) p.id, p.permit_type, r.payload
            FROM permits p JOIN sources s ON s.slug = p.source_area
            JOIN raw_records r ON r.source_id = s.id AND r.source_key = p.permit_number
           WHERE p.source_area = $1 ORDER BY p.id, r.id DESC)
        SELECT split_part(permit_type, ' ', 1) AS kind, count(*)::int AS n
          FROM latest r WHERE ${pick} IS NOT NULL AND ${pick} <> '${cols[0]}'
         GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [slug]);
      if (comp.length) {
        out(`Records shown with a value that is NOT \`${cols[0]}\`, by permit type prefix:`);
        out();
        table(['Type prefix', 'Records'], comp.map((r) => [r.kind, r.n]));
      }
    }
    // Where the total disagrees with the sum of its parts (Austin only).
    if (cols.includes('total_job_valuation')) {
      const parts = ['building_valuation', 'electrical_valuation', 'mechanical_valuation', 'plumbing_valuation',
        'building_valuation_remodel', 'electrical_valuation_remodel', 'mechanical_valuation_remodel', 'plumbing_valuation_remodel', 'medgas_valuation', 'medgas_valuation_remodel']
        .map((c) => `coalesce(CASE WHEN (r.payload->>'${c}') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (r.payload->>'${c}')::numeric END, 0)`).join(' + ');
      const [d] = await q(`
        WITH latest AS (
          SELECT DISTINCT ON (p.id) p.id, r.payload FROM permits p JOIN sources s ON s.slug = p.source_area
            JOIN raw_records r ON r.source_id = s.id AND r.source_key = p.permit_number
           WHERE p.source_area = $1 ORDER BY p.id, r.id DESC)
        SELECT count(*) FILTER (WHERE nullif(payload->>'total_job_valuation','') IS NOT NULL)::int AS with_total,
               count(*) FILTER (WHERE nullif(payload->>'total_job_valuation','') IS NOT NULL AND (${parts.replace(/r\.payload/g, 'payload')}) > 0
                                  AND abs(CASE WHEN (payload->>'total_job_valuation') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (payload->>'total_job_valuation')::numeric END - (${parts.replace(/r\.payload/g, 'payload')})) > 1)::int AS total_ne_parts
          FROM latest`, [slug]);
      out(`Total present on ${d.with_total} records; total differs from the sum of the component columns on ${d.total_ne_parts}.`);
      out();
    }
  }

  out('## Largest values per source (type, value, units of the description)');
  out();
  const big = await q(`
    SELECT * FROM (
      SELECT source_area, permit_number, permit_type, valuation, left(work_description, 90) AS d,
             row_number() OVER (PARTITION BY source_area ORDER BY valuation DESC NULLS LAST) AS rk
        FROM permits WHERE source_area = ANY($1) AND valuation IS NOT NULL) x WHERE rk <= 8 ORDER BY source_area, rk`, [slugs]);
  table(['Source', 'Permit', 'Type', 'Value', 'Description (start)'], big.map((r) => [r.source_area, r.permit_number, r.permit_type, money(r.valuation), r.d]));

  out('## Small values (under $100) by source and type');
  out();
  table(['Source', 'Type', 'Records'], (await q(`
    SELECT source_area, permit_type, count(*)::int AS n FROM permits
     WHERE source_area = ANY($1) AND valuation > 0 AND valuation < 100 GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`, [slugs])).map((r) => [r.source_area, r.permit_type, r.n]));

  out('## Status labels by record type (is the fix type-independent?)');
  out();
  table(['Source', 'Type prefix', 'Status', 'Group', 'Lifecycle', 'Records'], (await q(`
    SELECT source_area, split_part(permit_type, ' ', 1) AS kind, status_raw, status_stage, lifecycle_stage, count(*)::int AS n
      FROM permits WHERE source_area = 'austin-plan-review-tx' GROUP BY 1, 2, 3, 4, 5 HAVING count(*) >= 20 ORDER BY 6 DESC LIMIT 30`)).map((r) => [r.source_area, r.kind, r.status_raw, r.status_stage, r.lifecycle_stage, r.n]));
}

main().catch((err) => { out(`_Failed: ${err.code || ''} ${err.message}_`); process.exitCode = 1; }).finally(() => db.getPool().end());
