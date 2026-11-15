// Integration: the data-engine hardening (migration 035) through a real
// ingestArea run against a stubbed Austin plan-review endpoint
// (datahub.austintexas.gov n8ck-xkda): applications before approval.
//
// Covers the brief's phase 4 checks end to end:
//   - pagination completeness: 2,500 rows over three 1,000-row pages
//   - idempotent re-ingest: a second identical run adds 0 rows anywhere
//   - status changes land in record_status_changelog as old -> new
//   - pre-approval statuses are captured with their lifecycle stage
// and the phase 1 additions: per-record source_url, untouched raw payload,
// watermarks (advance, widen, hold on truncation), Zod row validation and
// rate-limit events in connector_health_logs, the lifecycle CHECK, and
// append-only history.
//
// Needs Postgres (DATABASE_URL; default localhost:5433). Creates and drops
// its own throwaway database.

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_engine_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const STATUSES = ['In Review', 'Pending', 'Awaiting Update', 'Approved'];
const row = (n, status = STATUSES[n % STATUSES.length]) => ({
  permit_number: `2026-${String(n).padStart(6, '0')} PR`, sub_type: 'R- 101 Single Family Houses',
  folder_description: 'New single family residence', status_current: status,
  applied_date: '2026-11-01T00:00:00.000', status_date: '2026-11-10T00:00:00.000',
  project_name: `${n} OAK ST`,
});

let dataset = [];
let calls = [];
let script = []; // per-request overrides: { status, headers } served before the dataset
global.fetch = async (url) => {
  calls.push(decodeURIComponent(url).replace(/\+/g, ' '));
  const next = script.shift();
  if (next) {
    return { ok: false, status: next.status, headers: { get: (k) => (next.headers || {})[k] ?? null }, text: async () => 'busy', json: async () => ({}) };
  }
  const u = new URL(url);
  const offset = Number(u.searchParams.get('$offset') || 0);
  const limit = Number(u.searchParams.get('$limit') || 1000);
  const page = dataset.slice(offset, offset + limit);
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => page, text: async () => JSON.stringify(page) };
};

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  const one = async (sql, p) => (await q(sql, p))[0];
  const AREA = 'austin-plan-review-tx';
  const run = (opts = {}) => ingestArea(AREA, { days: 14, allDetails: false, ...opts });
  const lastRun = () => one('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1');
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };

  try {
    await db.applySchema();
    const sourceId = await db.getSourceId(AREA);

    await check('a multi-page fetch reads all 2,500 rows across three pages (pagination completeness)', async () => {
      dataset = Array.from({ length: 2500 }, (_, i) => row(i + 1));
      calls = [];
      await run();
      const r = await lastRun();
      assert.strictEqual(r.status, 'succeeded');
      // Window 1 (applied_date): 1000 + 1000 + 500. Window 2 (status_date)
      // returns the same rows again, kept once.
      assert.strictEqual(r.records_fetched, 2500);
      assert.strictEqual(r.requests_made, 6);
      assert.deepStrictEqual(calls.slice(0, 3).map((u) => (u.match(/\$offset=(\d+)/) || [])[1]), ['0', '1000', '2000']);
      assert.strictEqual((await one(`SELECT count(*)::int AS n FROM permits WHERE source_area = $1`, [AREA])).n, 2500);
    });

    await check('pre-approval statuses are captured with their lifecycle stage, none as issued', async () => {
      const rows = await q(`SELECT lifecycle_stage, lifecycle_phase(lifecycle_stage) AS phase, count(*)::int AS n
                              FROM permits WHERE source_area = $1 GROUP BY 1, 2 ORDER BY 1`, [AREA]);
      assert.deepStrictEqual(rows.map((r) => [r.lifecycle_stage, r.phase, r.n]), [
        ['approved', 'approved', 625], ['corrections', 'plan_review', 625],
        ['in_review', 'plan_review', 625], ['submitted', 'application_submitted', 625],
      ]);
      assert.strictEqual((await one(`SELECT count(*)::int AS n FROM permits WHERE source_area = $1 AND status_stage = 'issued'`, [AREA])).n, 0);
      // The index the early screens filter on is used for this stage lookup.
      assert.ok((await one(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'permits_lifecycle'`)).n === 1);
    });

    await check('each raw record keeps the untouched payload, its fetch time and a URL that re-fetches it', async () => {
      const r = await one(`SELECT payload, source_url, fetched_at, source_updated_at FROM raw_records
                            WHERE source_id = $1 AND source_key = '2026-000007 PR'`, [sourceId]);
      assert.deepStrictEqual(r.payload, row(7));
      assert.strictEqual(r.source_url, 'https://datahub.austintexas.gov/resource/n8ck-xkda.json?permit_number=2026-000007+PR');
      assert.ok(r.fetched_at instanceof Date);
      // Austin declares no modification column: NULL, never a guessed time.
      assert.strictEqual(r.source_updated_at, null);
    });

    await check('a successful run advances a watermark per window, with the newest source date seen', async () => {
      const rows = await q(`SELECT window_field, high_water_value, last_sync_run_id FROM source_watermarks
                             WHERE source_id = $1 ORDER BY window_field`, [sourceId]);
      const r = await lastRun();
      assert.deepStrictEqual(rows.map((w) => [w.window_field, w.high_water_value.toISOString(), Number(w.last_sync_run_id)]), [
        ['applied_date', '2026-11-01T00:00:00.000Z', Number(r.id)],
        ['status_date', '2026-11-10T00:00:00.000Z', Number(r.id)],
      ]);
    });

    await check('re-running the same sync adds 0 permits, 0 raw rows and 0 history rows (idempotent)', async () => {
      const before = await one(`SELECT (SELECT count(*) FROM permits)::int AS p, (SELECT count(*) FROM raw_records)::int AS r,
                                       (SELECT count(*) FROM permit_status_history)::int AS h`);
      await run();
      const after = await one(`SELECT (SELECT count(*) FROM permits)::int AS p, (SELECT count(*) FROM raw_records)::int AS r,
                                      (SELECT count(*) FROM permit_status_history)::int AS h`);
      assert.deepStrictEqual(after, before);
      const r = await lastRun();
      assert.deepStrictEqual([r.status, r.records_new, r.records_changed], ['succeeded', 0, 0]);
      const dup = await one(`SELECT count(*)::int AS n FROM (SELECT source_area, permit_number FROM permits GROUP BY 1, 2 HAVING count(*) > 1) d`);
      assert.strictEqual(dup.n, 0);
    });

    await check('a status change is one new raw version and one old -> new changelog entry', async () => {
      dataset[4] = { ...row(5), status_current: 'Approved', status_date: '2026-11-14T00:00:00.000' }; // was 'Pending'
      await run();
      const r = await lastRun();
      assert.deepStrictEqual([r.records_new, r.records_changed], [0, 1]);
      const p = await one(`SELECT id FROM permits WHERE source_area = $1 AND permit_number = '2026-000005 PR'`, [AREA]);
      const log = await q(`SELECT field_changed, old_value, new_value FROM record_status_changelog
                            WHERE record_type = 'permit' AND record_id = $1 AND old_value IS NOT NULL ORDER BY field_changed`, [p.id]);
      assert.deepStrictEqual(log.map((x) => [x.field_changed, x.old_value, x.new_value]), [
        ['lifecycle_stage', 'submitted', 'approved'],
        ['stage_since', '2026-11-10', '2026-11-14'],
        ['status_raw', 'Pending', 'Approved'],
      ]);
      // The first observation is in the changelog too, with no old value.
      const first = await q(`SELECT new_value FROM record_status_changelog
                              WHERE record_type = 'permit' AND record_id = $1 AND field_changed = 'status_raw' AND old_value IS NULL`, [p.id]);
      assert.deepStrictEqual(first.map((x) => x.new_value), ['Pending']);
    });

    await check('history is append-only: observed values cannot be edited or deleted', async () => {
      const h = await one('SELECT id, permit_id FROM permit_status_history ORDER BY id LIMIT 1');
      await assert.rejects(() => db.query(`UPDATE permit_status_history SET status_raw = 'Issued' WHERE id = $1`, [h.id]), /append-only/);
      await assert.rejects(() => db.query('DELETE FROM permit_status_history WHERE id = $1', [h.id]), /append-only/);
      // Restaging the derived stage (ingest/lifecycle.js) stays possible.
      await db.query(`UPDATE permit_status_history SET lifecycle_stage = lifecycle_stage WHERE id = $1`, [h.id]);
      // A record's history goes with the record (ON DELETE CASCADE).
      await db.query('DELETE FROM permits WHERE id = $1', [h.permit_id]);
      assert.strictEqual((await one('SELECT count(*)::int AS n FROM permit_status_history WHERE permit_id = $1', [h.permit_id])).n, 0);
    });

    await check('a lifecycle stage outside the vocabulary is refused by the database', async () => {
      await assert.rejects(() => db.query(`UPDATE permits SET lifecycle_stage = 'hiring' WHERE id = (SELECT min(id) FROM permits)`), /permits_lifecycle_stage_check/);
    });

    await check('after an outage the windows reach back past the last success', async () => {
      await db.query(`UPDATE source_watermarks SET last_successful_sync_at = now() - interval '40 days' WHERE source_id = $1`, [sourceId]);
      calls = [];
      await run();
      // applied_date (30d) and status_date (14d) both widen past the 40 days:
      // whole days since the last success (40 and a few ms -> 41) plus one of overlap.
      const since = (field) => {
        const u = calls.find((c) => c.includes(`${field} >= `));
        return Math.round((Date.now() - Date.parse(`${u.match(new RegExp(`${field} >= '([^']+)'`))[1]}Z`)) / 86400000);
      };
      assert.strictEqual(since('applied_date'), 42);
      assert.strictEqual(since('status_date'), 42);
      const w = await one(`SELECT min(last_successful_sync_at) AS m FROM source_watermarks WHERE source_id = $1`, [sourceId]);
      assert.ok(Date.now() - w.m.getTime() < 3600000, 'the successful run moved the watermark to now');
    });

    await check('a truncated run keeps the watermark, so the next run reads the cut rows again', async () => {
      await db.query(`UPDATE source_watermarks SET last_successful_sync_at = now() - interval '2 days' WHERE source_id = $1`, [sourceId]);
      const before = await one(`SELECT max(last_successful_sync_at) AS m FROM source_watermarks WHERE source_id = $1`, [sourceId]);
      await run({ max: 1500 });
      const after = await one(`SELECT max(last_successful_sync_at) AS m FROM source_watermarks WHERE source_id = $1`, [sourceId]);
      assert.strictEqual(after.m.getTime(), before.m.getTime());
      assert.strictEqual((await one(`SELECT count(*)::int AS n FROM source_events WHERE source_id = $1 AND kind = 'truncated'`, [sourceId])).n, 1);
    });

    await check('bad keys and dates are counted in one validation event; the rows are still stored raw', async () => {
      dataset.push({ ...row(9001), applied_date: 'see notes' }, { ...row(9002), permit_number: '' });
      await run();
      const e = await one(`SELECT severity, detail FROM source_events WHERE source_id = $1 AND kind = 'validation' ORDER BY id DESC LIMIT 1`, [sourceId]);
      assert.strictEqual(e.severity, 'warning');
      // Both windows return the keyless row, and without a key it cannot be
      // told apart from a second one, so it counts twice.
      assert.deepStrictEqual([e.detail.invalid, e.detail.byColumn], [3, { applied_date: 1, permit_number: 2 }]);
      assert.strictEqual((await one(`SELECT count(*)::int AS n FROM raw_records WHERE source_id = $1 AND source_key = '2026-009001 PR'`, [sourceId])).n, 1);
      // The unreadable date maps to NULL, not to a guessed date.
      assert.strictEqual((await one(`SELECT filed_date FROM permits WHERE permit_number = '2026-009001 PR'`)).filed_date, null);
    });

    await check('a 429 is retried after Retry-After and recorded as a rate_limited event', async () => {
      script = [{ status: 429, headers: { 'retry-after': '1' } }];
      await run();
      assert.strictEqual((await lastRun()).status, 'succeeded');
      const e = await one(`SELECT severity, detail FROM source_events WHERE source_id = $1 AND kind = 'rate_limited' ORDER BY id DESC LIMIT 1`, [sourceId]);
      assert.strictEqual(e.severity, 'warning');
      assert.deepStrictEqual([e.detail.retries, e.detail.rateLimited], [1, 1]);
    });

    await check('a failed run is recorded with its class and shows in connector_health_logs with the alerts', async () => {
      script = [{ status: 400 }];
      await assert.rejects(() => run());
      const r = await lastRun();
      assert.deepStrictEqual([r.status, r.error_class], ['failed', 'unknown']);
      const alerts = await q(`SELECT alert, severity FROM connector_health_logs WHERE source = $1 ORDER BY alert`, [AREA]);
      assert.deepStrictEqual([...new Set(alerts.map((a) => a.alert))], ['rate_limited', 'sync_failed', 'truncated', 'validation']);
    });

    await check('a failed run does not advance the watermark', async () => {
      const w = await one(`SELECT max(last_sync_run_id)::bigint AS id FROM source_watermarks WHERE source_id = $1`, [sourceId]);
      const r = await lastRun();
      assert.ok(Number(w.id) < Number(r.id));
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nDone.');
}

main().catch((err) => { console.error(err); process.exit(1); });
