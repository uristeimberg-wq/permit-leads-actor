// Integration: migration 002 plus a real ingestArea run against a stubbed
// Austin endpoint. Needs Postgres (DATABASE_URL; default localhost:5433).
// Each run creates and drops its own throwaway database.
//
//   npm run test:integration

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const ROW = (n, status = 'Active') => ({
  permit_number: `2026-${n} BP`, permit_type_desc: 'Building Permit', description: 'Remodel kitchen',
  status_current: status, issue_date: '2026-11-10T00:00:00.000', original_address1: `${n} MAIN ST`,
  original_city: 'AUSTIN', original_state: 'TX', original_zip: '78701',
  contractor_company_name: 'Acme Builders', contractor_phone: '5125550100',
});

let pages = [];
global.fetch = async () => {
  const page = pages.shift() || [];
  return { ok: true, json: async () => page, text: async () => JSON.stringify(page) };
};

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); }
    catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };

  try {
    await db.applySchema();

    await check('the migrations enable exactly the pilot markets', async () => {
      // Planning and inspection sources are pilot areas too: they sync daily.
      const rows = await q("SELECT slug, enabled, sync_mode, homeowner_use, automated_access FROM sources WHERE role IN ('permits', 'planning', 'inspections') ORDER BY slug");
      assert.deepStrictEqual(rows.filter((r) => r.enabled).map((r) => r.slug), [...require('../../src/sources.js').PILOT_AREAS].sort());
      assert.ok(rows.every((r) => r.homeowner_use === 'blocked' && r.automated_access === 'unknown'));
    });

    await check('a first sync stores every raw row and records a succeeded run', async () => {
      pages = [[ROW(1), ROW(2), ROW(3)]];
      await ingestArea('austin-tx', { days: 14, max: 100, allDetails: false });
      const [run] = await q('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1');
      assert.strictEqual(run.status, 'succeeded');
      assert.strictEqual(run.kind, 'manual');
      // Two requests: Austin's issue_date and statusdate windows (ADR-11).
      assert.deepStrictEqual([run.records_fetched, run.records_new, run.records_changed, run.records_failed, run.requests_made], [3, 3, 0, 0, 2]);
      assert.strictEqual((await q('SELECT count(*)::int AS n FROM raw_records'))[0].n, 3);
    });

    await check('re-running the same sync writes 0 new raw rows (M1 exit check)', async () => {
      pages = [[ROW(3), ROW(1), ROW(2)]];
      await ingestArea('austin-tx', { days: 14, max: 100, allDetails: false });
      const [run] = await q('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1');
      assert.deepStrictEqual([run.records_new, run.records_changed], [0, 0]);
      assert.strictEqual((await q('SELECT count(*)::int AS n FROM raw_records'))[0].n, 3);
      assert.strictEqual((await q("SELECT count(*)::int AS n FROM permits WHERE source_area = 'austin-tx'"))[0].n, 3);
    });

    await check('a changed row becomes a second version, not a duplicate permit', async () => {
      pages = [[ROW(1, 'Final'), ROW(2), ROW(4), { permit_number: '' }]];
      await ingestArea('austin-tx', { days: 14, max: 100, allDetails: false });
      const [run] = await q('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1');
      assert.deepStrictEqual([run.records_new, run.records_changed, run.records_failed], [1, 1, 1]);
      const versions = await q("SELECT count(*)::int AS n FROM raw_records WHERE source_key = '2026-1 BP'");
      assert.strictEqual(versions[0].n, 2);
    });

    await check('migration 003 switches Austin to date windows', async () => {
      const [src] = await q("SELECT sync_mode FROM sources WHERE slug = 'austin-tx'");
      assert.strictEqual(src.sync_mode, 'date_window');
    });

    await check('a failing sync is recorded with its error class', async () => {
      const saved = global.fetch;
      global.fetch = async () => ({ ok: false, status: 503, text: async () => 'down' });
      await assert.rejects(() => ingestArea('austin-tx', { days: 14, max: 100, allDetails: false, kind: 'scheduled' }));
      global.fetch = saved;
      const [run] = await q('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1');
      assert.deepStrictEqual([run.status, run.kind, run.error_class], ['failed', 'scheduled', 'transient']);
      assert.match(run.error_detail, /HTTP 503/);
    });

    await check('the table refuses a failed run without an error class', async () => {
      const [{ id }] = await q("SELECT id FROM sources WHERE slug = 'austin-tx'");
      await assert.rejects(() => q("INSERT INTO sync_runs (source_id, kind, status) VALUES ($1, 'manual', 'failed')", [id]), /check/i);
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
