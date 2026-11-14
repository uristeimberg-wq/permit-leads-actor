// Daily data-quality scorecard (ADR-23): runs every src/scorecard.js metric
// and stores today's value per market in scorecard_snapshots (migration 021).
// Re-running the same day replaces the day's values (no duplicates). Prints a
// Markdown table with the day-30 and day-90 targets.
//
//   node ingest/scorecard.js

const db = require('../db/index.js');
const { METHOD_VERSION, METRICS, toSnapshot, status } = require('../src/scorecard.js');

async function runScorecard() {
  const [{ day }] = (await db.query('SELECT current_date::text AS day')).rows;
  const rows = [];
  const failed = [];
  for (const [metric, m] of Object.entries(METRICS)) {
    try {
      for (const r of (await db.query(m.sql)).rows) {
        const s = toSnapshot(metric, r, day);
        if (s) rows.push(s);
      }
    } catch (err) {
      failed.push(`${metric}: ${err.message}`); // reported, never silent (rule 3)
    }
  }
  if (rows.length) {
    const col = (k) => rows.map((r) => r[k]);
    await db.query(`
      INSERT INTO scorecard_snapshots (measured_on, market, metric, value, unit, numerator, denominator, method_version)
      SELECT d::date, m, k, v, u, n, de, $8 FROM unnest($1::text[], $2::text[], $3::text[], $4::numeric[], $5::text[], $6::numeric[], $7::numeric[])
        AS t(d, m, k, v, u, n, de)
      ON CONFLICT (measured_on, market, metric) DO UPDATE SET
        value = EXCLUDED.value, unit = EXCLUDED.unit, numerator = EXCLUDED.numerator, denominator = EXCLUDED.denominator,
        method_version = EXCLUDED.method_version, computed_at = now()`,
    [col('measured_on'), col('market'), col('metric'), col('value'), col('unit'), col('numerator'), col('denominator'), METHOD_VERSION]);
  }
  return { day, rows, failed };
}

const fmt = (unit, v) => (v == null ? 'n/a' : unit === 'share' ? `${Math.round(v * 1000) / 10}%` : String(Math.round(v * 10) / 10));

async function main() {
  await db.applySchema();
  const { day, rows, failed } = await runScorecard();
  const lines = [`## Data-quality scorecard, ${day}`, '', '| metric | market | value | day-30 target | day-90 target |', '|---|---|---|---|---|'];
  for (const r of rows) {
    const m = METRICS[r.metric];
    const t = (x) => (x == null ? '' : `${fmt(m.unit, x)} ${status(r.metric, r.value, x) === 'met' ? '✓' : '✗'}`);
    lines.push(`| ${r.metric} | ${r.market} | ${fmt(r.unit, r.value)}${r.denominator ? ` (${r.numerator}/${r.denominator})` : ''} | ${t(m.target30)} | ${t(m.target90)} |`);
  }
  if (failed.length) lines.push('', `Failed metrics: ${failed.join('; ')}`);
  console.log(lines.join('\n'));
  await db.close();
  if (failed.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
}

module.exports = { runScorecard };
