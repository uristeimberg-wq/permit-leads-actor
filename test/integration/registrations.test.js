// Integration: Texas business registrations (migration 024) against a stubbed
// Comptroller API. Contractors are inserted directly. Needs Postgres
// (DATABASE_URL; default :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_reg_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();
const fx = require('../fixtures/enrichment/tx-comptroller.json');

const SEARCH = {
  'IES RESIDENTIAL': fx.search['IES Residential, Inc.'],
  'CHRISTIANSON PLUMBING': fx.search['Christianson Plumbing'],
  'VICTORY PLUMBING': fx.search['Victory Plumbing Company'],
  'TWIN PEAKS': { success: true, data: [{ name: 'TWIN PEAKS LLC', taxpayerId: '1' }, { name: 'TWIN PEAKS, L.L.C.', taxpayerId: '2' }], count: 2 },
};
const calls = [];
let throttleOnce = true;
let reject = false;
const stub = async (url, init) => {
  const u = new URL(url);
  calls.push(u.pathname + u.search);
  assert.ok(init.headers['x-api-key'], 'the key is sent as x-api-key');
  if (reject) return { ok: false, status: 401, json: async () => ({ success: false }) };
  if (throttleOnce && u.pathname.endsWith('/franchise-tax-list')) { throttleOnce = false; return { ok: false, status: 429, json: async () => ({}) }; }
  if (u.pathname.endsWith('/franchise-tax-list')) {
    const body = SEARCH[u.searchParams.get('name')] || { success: true, data: [], count: 0 };
    return { ok: true, status: 200, json: async () => body };
  }
  return { ok: true, status: 200, json: async () => fx.detail };
};

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { enrichRegistrations, coverage } = require('../../ingest/enrich_registrations.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  const run = (o = {}) => enrichRegistrations({ key: 'k', fetchImpl: stub, minIntervalMs: 0, backoffMs: [0], ...o });
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  try {
    await db.applySchema();
    await q(`INSERT INTO contractors (identity_key, display_name, normalized_name, party_kind, business_state, permit_count, resolver_version) VALUES
      ('name:TX:ies residential', 'IES Residential, Inc.', 'ies residential', 'business', 'TX', 40, 't'),
      ('name:TX:christianson plumbing', 'Christianson Plumbing', 'christianson plumbing', 'business', 'TX', 9, 't'),
      ('name:TX:victory plumbing', 'Victory Plumbing Company', 'victory plumbing', 'business', 'TX', 5, 't'),
      ('name:TX:twin peaks', 'Twin Peaks LLC', 'twin peaks', 'business', 'TX', 3, 't'),
      ('name:TX:jane doe', 'Jane Doe', 'jane doe', 'individual', 'TX', 7, 't'),
      ('lic:FL:CGC1', 'Florida Co', 'florida', 'business', 'FL', 7, 't')`);

    await check('without a key nothing runs and nothing is recorded', async () => {
      assert.deepStrictEqual(await enrichRegistrations({ key: '' }), { skipped: 'TX_COMPTROLLER_API_KEY is not set' });
      assert.strictEqual(calls.length, 0);
    });

    await check('Texas businesses only; a 429 is retried; one exact taxpayer links, ambiguous and prefix do not', async () => {
      const s = await run();
      assert.deepStrictEqual([s.looked, s.matched, s.ambiguous, s.prefix, s.none, s.error, s.linked], [4, 1, 1, 1, 1, 0, 1]);
      assert.ok(!calls.some((c) => /JANE|FLORIDA/.test(c)), 'people and other states are never sent');
      assert.ok(calls[0] === calls[1], 'the throttled request was repeated');
      const [link] = await q(`SELECT c.display_name, g.registry_id, g.sos_file_number, g.right_to_transact, cr.match_rule, cr.match_confidence::float AS conf
                                FROM contractor_registrations cr JOIN contractors c ON c.id = cr.contractor_id
                                JOIN business_registrations g ON g.id = cr.registration_id`);
      assert.deepStrictEqual(link, { display_name: 'IES Residential, Inc.', registry_id: '32012778745', sos_file_number: '0800862442',
        right_to_transact: 'ACTIVE', match_rule: 'name_state', conf: 0.8 });
      const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'business_registrations'")).map((r) => r.column_name);
      assert.ok(!cols.some((c) => /officer|agent|street|fei/.test(c)));
    });

    await check('a re-run asks nothing (fresh lookups) and keeps one link', async () => {
      const before = calls.length;
      const s = await run();
      assert.deepStrictEqual([s.looked, calls.length - before, s.linked], [0, 0, 1]);
      const runs = await q("SELECT r.status, r.records_fetched FROM sync_runs r JOIN sources s ON s.id = r.source_id WHERE s.slug = 'tx-comptroller' ORDER BY r.id");
      assert.deepStrictEqual(runs.map((r) => r.status), ['succeeded', 'succeeded']);
    });

    await check('coverage: verified share of looked-up businesses and of their permits', async () => {
      const c = await coverage();
      assert.deepStrictEqual([c.businesses, c.looked, c.verified, c.permits, c.verified_permits], [4, 4, 1, 57, 40]);
    });

    await check('a rejected key fails the run with its error class and stops', async () => {
      await q("UPDATE registry_lookups SET looked_up_at = now() - interval '200 days'");
      reject = true;
      await assert.rejects(run(), /HTTP 401/);
      const [last] = await q("SELECT r.status, r.error_class FROM sync_runs r JOIN sources s ON s.id = r.source_id WHERE s.slug = 'tx-comptroller' ORDER BY r.id DESC LIMIT 1");
      assert.deepStrictEqual([last.status, last.error_class], ['failed', 'auth']);
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
