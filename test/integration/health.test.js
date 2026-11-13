// Integration: schema-drift recording, source_health, the health check's
// measurements and raw retention, through real ingestArea runs against a
// stubbed Austin endpoint. Needs Postgres (DATABASE_URL; default :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_h_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const today = new Date().toISOString().slice(0, 10);
const row = (n, o = {}) => ({
  permit_number: `2026-${n} BP`, permittype: 'BP', permit_type_desc: 'Building Permit', description: 'Remodel',
  status_current: 'Active', issue_date: `${today}T00:00:00.000`, original_address1: `${n} MAIN ST`, original_city: 'AUSTIN',
  original_state: 'TX', original_zip: '78701', contractor_company_name: 'Acme Builders LLC', contractor_phone: '5125550100', ...o,
});
const many = (k, o) => Array.from({ length: k }, (_, i) => row(i + 1, o));

let pages = [];
global.fetch = async () => { const page = pages.shift() || []; return { ok: true, json: async () => page, text: async () => '' }; };

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const { resolveAll } = require('../../ingest/resolve.js');
  const { evaluate, measure } = require('../../ingest/health.js');
  const { pruneRaw } = require('../../ingest/prune.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  const sync = async (rows) => { pages = [rows]; await ingestArea('austin-tx', { days: 14, max: 100000, allDetails: false }); };

  try {
    await db.applySchema();

    await check('the first sync stores the field list and raises no drift', async () => {
      await sync(many(600));
      const [s] = await q("SELECT field_list FROM sources WHERE slug = 'austin-tx'");
      assert.ok(s.field_list.includes('contractor_phone'));
      assert.strictEqual((await q('SELECT count(*)::int AS n FROM source_events'))[0].n, 0);
    });

    await check('a dropped mapped column is recorded as an error event and fails the health check', async () => {
      await sync(many(600, { contractor_phone: undefined, brand_new_col: 'x' }).map((r) => { const { contractor_phone: _p, ...rest } = r; return rest; }));
      const ev = await q('SELECT severity, detail FROM source_events ORDER BY id');
      assert.deepStrictEqual(ev.map((e) => e.severity).sort(), ['error', 'info']);
      assert.ok(ev.some((e) => e.detail.missingMappedField === 'contractor_phone'));
      await resolveAll();
      const { problems } = evaluate(await measure());
      assert.ok(problems.some((p) => /contractor_phone/.test(p)), problems.join('\n'));
    });

    await check('source_health: fresh success, not stale; Miami never synced is stale', async () => {
      const h = await q('SELECT slug, stale, consecutive_failures, new_records_7d FROM source_health ORDER BY slug');
      const austin = h.find((r) => r.slug === 'austin-tx');
      assert.deepStrictEqual([austin.stale, austin.consecutive_failures, austin.new_records_7d], [false, 0, 600]);
      assert.strictEqual(h.find((r) => r.slug === 'miami-dade-fl').stale, true);
    });

    await check('raw retention deletes only superseded payloads past the window', async () => {
      // Age every raw record, then prune: each permit keeps its latest payload.
      await db.query("UPDATE raw_records SET fetched_at = fetched_at - interval '200 days'");
      const before = (await q('SELECT count(*)::int AS n FROM raw_records'))[0].n;
      const deleted = await pruneRaw();
      const after = await q('SELECT count(DISTINCT source_key)::int AS keys, count(*)::int AS n FROM raw_records');
      assert.strictEqual(before, 1200);
      assert.strictEqual(deleted, 600);
      assert.deepStrictEqual(after[0], { keys: 600, n: 600 });
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
