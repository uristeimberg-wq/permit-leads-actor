// Data health check (ADR-14). Runs on its own schedule (health.yml), separate
// from the sync, because a sync that never starts records nothing.
//
// Prints a Markdown report and exits 1 when anything needs a person:
//   - a source with no successful sync within 1.5x its expected interval
//   - the newest permit we hold is older than the source's maxDataAgeDays
//     (the source stopped publishing, or our date window broke)
//   - a mapped field vanished from a source in the last 7 days (schema drift)
//   - the contractor resolver failed or has not succeeded in 36 hours
//   - the database is above STORAGE_ALERT_PCT of DB_SIZE_LIMIT_MB
//   - the rolling re-read (ingest/refresh.js) failed in the last 36 hours, or
//     a source holds a permit not confirmed against it in REREAD_MAX_DAYS
//
//   node ingest/health.js            (DATABASE_URL)

const db = require('../db/index.js');
const { SOURCES } = require('../src/sources.js');

// Neon Launch (upgraded 2026-11-14) has no storage cap: "Storage is unlimited
// on paid plans", billed at $0.35/GB-month (neon.com/docs/introduction/plans,
// read 2026-11-14). So this is a budget alarm, not a wall: 5 GB is about
// $1.75 a month, and 80% of it means growth worth a look.
const LIMIT_MB = Number(process.env.DB_SIZE_LIMIT_MB || 5120);
const ALERT_PCT = Number(process.env.STORAGE_ALERT_PCT || 80);
// Austin's store (~150k permits) at 10,000 a day cycles in about 15 days;
// twice that means the re-read is not keeping up.
const REREAD_MAX_DAYS = Number(process.env.REREAD_MAX_DAYS || 30);

/** Pure: turns the measurements into problems. Exported for tests. */
function evaluate({ sources, dataAge, events, resolver, sizeBytes, reread = null, now = new Date() }) {
  const problems = [];
  for (const r of reread || []) {
    if (r.last_refresh_status === 'failed') problems.push(`${r.slug}: the last re-read failed (${r.last_refresh_error || 'unknown'})`);
    if (r.oldest_days != null && r.oldest_days > REREAD_MAX_DAYS) {
      problems.push(`${r.slug}: a stored permit was last confirmed against the source ${r.oldest_days} days ago, limit ${REREAD_MAX_DAYS}`);
    }
  }
  for (const s of sources) {
    if (s.stale) {
      problems.push(`${s.slug}: no successful sync since ${s.last_success_at ? new Date(s.last_success_at).toISOString() : 'ever'}`
        + `${s.consecutive_failures ? ` (${s.consecutive_failures} failed run(s) since, last error ${s.last_error_class})` : ''}`);
    }
    const age = dataAge.find((d) => d.source_area === s.slug);
    const maxAge = SOURCES[s.slug] && SOURCES[s.slug].maxDataAgeDays;
    if (maxAge && (!age || age.days_old > maxAge)) {
      problems.push(`${s.slug}: newest permit issued ${age ? `${age.days_old} days ago (${age.newest})` : 'never'}, limit ${maxAge} days`);
    }
  }
  for (const e of events.filter((x) => x.severity === 'error')) {
    problems.push(`${e.slug}: ${e.kind} ${JSON.stringify(e.detail)} at ${new Date(e.created_at).toISOString()}`);
  }
  if (!resolver || resolver.status === 'failed'
      || !resolver.last_success_at || now - new Date(resolver.last_success_at) > 36 * 3600000) {
    problems.push(`contractor resolver: last run ${resolver ? resolver.status : 'never'}, last success ${resolver && resolver.last_success_at ? new Date(resolver.last_success_at).toISOString() : 'never'}`);
  }
  const usedPct = (sizeBytes / (LIMIT_MB * 1048576)) * 100;
  if (usedPct >= ALERT_PCT) problems.push(`storage: ${(sizeBytes / 1048576).toFixed(0)} MB of ${LIMIT_MB} MB (${usedPct.toFixed(0)}%)`);
  return { problems, usedPct };
}

async function measure() {
  const [sources, dataAge, events, resolver, size] = await Promise.all([
    db.query('SELECT * FROM source_health ORDER BY slug'),
    db.query(`SELECT source_area, max(filed_date) AS newest, (current_date - max(filed_date))::int AS days_old
                FROM permits WHERE filed_date <= current_date GROUP BY source_area`),
    db.query(`SELECT s.slug, e.kind, e.severity, e.detail, e.created_at FROM source_events e JOIN sources s ON s.id = e.source_id
               WHERE e.created_at > now() - interval '7 days' AND e.severity <> 'info' ORDER BY e.created_at DESC`),
    db.query(`SELECT (SELECT status FROM resolver_runs ORDER BY id DESC LIMIT 1) AS status,
                     (SELECT max(finished_at) FROM resolver_runs WHERE status = 'succeeded') AS last_success_at`),
    db.query('SELECT pg_database_size(current_database())::bigint AS bytes'),
  ]);
  return {
    sources: sources.rows, dataAge: dataAge.rows, events: events.rows,
    resolver: resolver.rows[0], sizeBytes: Number(size.rows[0].bytes), reread: await measureReread(),
  };
}

/** Re-read cycle per permit source; null before migration 030 is applied. */
async function measureReread() {
  try {
    const { rows } = await db.query(
      `SELECT p.source_area AS slug,
              (current_date - min(coalesce(p.source_checked_at, p.last_seen_at))::date)::int AS oldest_days,
              count(*) FILTER (WHERE p.source_missing_since IS NOT NULL)::int AS missing,
              (SELECT r.status FROM sync_runs r JOIN sources s ON s.id = r.source_id
                WHERE s.slug = p.source_area AND r.kind = 'refresh' AND r.started_at > now() - interval '36 hours'
                ORDER BY r.started_at DESC LIMIT 1) AS last_refresh_status,
              (SELECT r.error_class FROM sync_runs r JOIN sources s ON s.id = r.source_id
                WHERE s.slug = p.source_area AND r.kind = 'refresh' AND r.started_at > now() - interval '36 hours'
                ORDER BY r.started_at DESC LIMIT 1) AS last_refresh_error
         FROM permits p WHERE p.source_area = ANY($1) GROUP BY 1 ORDER BY 1`,
      [Object.keys(SOURCES).filter((k) => SOURCES[k].refreshPerRun !== 0 && SOURCES[k].kind !== 'planning')]);
    return rows;
  } catch (err) {
    if (err.code === '42703' || err.code === '42P01') return null; // column or table not there yet
    throw err;
  }
}

function report(m, { problems, usedPct }) {
  const cell = (v) => (v == null ? '' : String(v).replace(/\|/g, '\\|'));
  const lines = ['## Data health', '', problems.length ? `**${problems.length} problem(s):**` : 'All checks passed.', ''];
  for (const p of problems) lines.push(`- ${p}`);
  lines.push('', '| Source | Last success (UTC) | Last attempt | Failures since | New rows 7d | Newest permit | Warnings 7d |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of m.sources) {
    const age = m.dataAge.find((d) => d.source_area === s.slug);
    lines.push(`| ${cell(s.slug)} | ${cell(s.last_success_at && new Date(s.last_success_at).toISOString().slice(0, 16))} | ${cell(s.last_status)} | ${s.consecutive_failures} | ${s.new_records_7d} | ${cell(age && `${age.newest.toISOString ? age.newest.toISOString().slice(0, 10) : age.newest} (${age.days_old}d)`)} | ${s.warnings_7d} |`);
  }
  if (m.reread) {
    lines.push('', '| Source | Oldest confirmation against the source (days) | Marked gone from the source | Last re-read (36h) |', '| --- | --- | --- | --- |');
    for (const r of m.reread) lines.push(`| ${cell(r.slug)} | ${cell(r.oldest_days)} | ${r.missing} | ${cell(r.last_refresh_status || 'none')} |`);
  } else {
    lines.push('', 'Re-read: not measured (migration 030 not applied).');
  }
  lines.push('', `Storage: ${(m.sizeBytes / 1048576).toFixed(0)} MB of ${LIMIT_MB} MB (${usedPct.toFixed(0)}%).`);
  return lines.join('\n');
}

async function main() {
  const m = await measure();
  const result = evaluate(m);
  console.log(report(m, result));
  await db.close();
  if (result.problems.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(async (err) => { console.error(`Health check could not run: ${err.message}`); await db.close(); process.exitCode = 2; });
}

module.exports = { evaluate, measure };
