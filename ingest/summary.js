// Prints a Markdown table of the latest sync run per enabled source, for the
// scheduled sync's job summary. Read-only.

const db = require('../db/index.js');

async function main() {
  const { rows } = await db.query(`
    SELECT s.slug, r.status, r.kind, r.started_at, r.finished_at, r.requests_made,
           r.records_fetched, r.records_new, r.records_changed, r.records_failed, r.error_class,
           left(r.error_detail, 160) AS error_detail
      FROM sources s
      LEFT JOIN LATERAL (
        SELECT * FROM sync_runs WHERE source_id = s.id ORDER BY started_at DESC LIMIT 1
      ) r ON true
     WHERE s.enabled
     ORDER BY s.slug`);
  const cell = (v) => (v == null ? '' : String(v).replace(/\|/g, '\\|').replace(/\n/g, ' '));
  const lines = ['## Sync runs', '', '| Source | Status | Started (UTC) | Requests | Fetched | New | Changed | No key | Error |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const r of rows) {
    lines.push(`| ${cell(r.slug)} | ${cell(r.status || 'never run')} | ${cell(r.started_at && r.started_at.toISOString().slice(0, 16))} | ${cell(r.requests_made)} | ${cell(r.records_fetched)} | ${cell(r.records_new)} | ${cell(r.records_changed)} | ${cell(r.records_failed)} | ${cell(r.error_class ? `${r.error_class}: ${r.error_detail}` : '')} |`);
  }
  const { rows: [rr] } = await db.query(
    "SELECT status, finished_at, stats, left(error_detail, 200) AS error FROM resolver_runs ORDER BY id DESC LIMIT 1").catch(() => ({ rows: [] }));
  if (rr) {
    const s = rr.stats || {};
    lines.push('', '## Contractor resolution', '', rr.status === 'succeeded'
      ? `${s.contractors} contractors from ${s.rawPermits} permits (${JSON.stringify(s.byRule)}); ${s.phonesShown} of ${s.phones} phones shown, ${s.phonesCorroborated} corroborated; ${s.relationships} GC-sub links.`
      : `Status **${rr.status}**: ${cell(rr.error)}`);
  }
  console.log(lines.join('\n'));
  await db.close();
}

main().catch(async (err) => { console.error(err.message); await db.close(); process.exitCode = 1; });
