// Integration: the overview API (/api/pilot/overview) over the same resolved
// Austin fixture as pilot_api.test.js. Checks the counts the first screen shows
// and the privacy rules: an individual GC is never named, ranked or phoned.
// Needs Postgres (DATABASE_URL; default :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_o_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000';
const row = (num, type, company, phone, ago, o = {}) => ({
  permit_number: `2026-${num} ${type}`, permittype: type, permit_type_desc: `${type} Permit`,
  description: type === 'BP' ? 'Remodel kitchen, relocate panel, new circuits' : 'Trade work',
  status_current: 'Active', issue_date: daysAgo(ago), original_address1: `${num} MAIN ST`,
  original_city: 'AUSTIN', original_state: 'TX', original_zip: num >= 7 ? '78745' : '78704',
  contractor_company_name: company, contractor_phone: phone, contractor_trade: null, total_job_valuation: '100000', ...o,
});

const ACME = ['Acme Builders LLC', '5125550100'];
const SPARKY = ['Sparky Electric Inc', '5125550200'];
const VOLT = ['Volt Electric LLC', '5125550300'];
const ZAP = ['Zap Electrical Services', '5125550400'];
const rows = [
  // Acme: Sparky on four jobs, then Volt on the latest one -> "changed".
  ...[1, 2, 3, 4].flatMap((n) => [row(n, 'BP', ...ACME, 60 - n * 5), row(n, 'EP', ...SPARKY, 50 - n * 5)]),
  row(5, 'BP', ...ACME, 30), row(5, 'EP', ...VOLT, 20),
  row(6, 'BP', ...ACME, 10), // no electrical yet -> open now, and a lead
  // Beta: three jobs, three electricians -> "spread".
  row(7, 'BP', 'Beta Homes Inc', '5125550500', 40), row(7, 'EP', ...SPARKY, 35),
  row(8, 'BP', 'Beta Homes Inc', '5125550500', 38), row(8, 'EP', ...VOLT, 33),
  row(9, 'BP', 'Beta Homes Inc', '5125550500', 36), row(9, 'EP', ...ZAP, 31),
  // An individual GC: name and phone must never be returned.
  row(10, 'BP', 'John Smith', '5125550999', 20), row(10, 'EP', ...SPARKY, 15),
];

const realFetch = global.fetch;
let pages = [];
global.fetch = async () => { const page = pages.shift() || []; return { ok: true, json: async () => page, text: async () => '' }; };

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  delete process.env.DEMO_PASSWORD;
  // These suites write (suppressions) and read the same URL again: no cache.
  process.env.API_CACHE = 'off';
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const { resolveAll } = require('../../ingest/resolve.js');
  const { app } = require('../../web/server.js');
  let server;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  try {
    await db.applySchema();
    pages = [rows];
    await ingestArea('austin-tx', { days: 14, max: 100, allDetails: false });
    await resolveAll();
    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p) => { const r = await realFetch(base + p); return { status: r.status, body: await r.json() }; };

    await check('front door: / serves the Leads page, /search stays an alias', async () => {
      const r = await realFetch(`${base}/`, { redirect: 'manual' });
      assert.strictEqual(r.status, 200);
      assert.match(await r.text(), /id="app"/);
      assert.strictEqual((await realFetch(`${base}/search`)).status, 200);
      assert.strictEqual((await realFetch(`${base}/search.html`)).status, 200);
      assert.strictEqual((await realFetch(`${base}/pilot/live/`)).status, 200);
    });

    let d;
    await check('totals count building permits, business GCs and phones', async () => {
      const res = await get('/api/pilot/overview?source=austin-tx');
      assert.strictEqual(res.status, 200);
      d = res.body;
      const t = d.totals;
      assert.strictEqual(t.permits, rows.length);
      assert.deepStrictEqual([t.buildingRecent, t.buildingRecentWithBusinessGc, t.buildingRecentWithPhone], [2, 1, 1]);
      assert.deepStrictEqual([t.activeGcs, t.activeSubs], [2, 3]);
      assert.strictEqual(t.buildingRecentMedianValue, 100000);
    });

    await check('26 weekly buckets, the current one flagged partial', async () => {
      assert.strictEqual(d.weekly.length, 26);
      assert.strictEqual(d.weekly[25].partial, true);
      const building = d.weekly.reduce((n, w) => n + (w.building || 0), 0);
      assert.strictEqual(building, 10);
    });

    await check('top GCs: businesses only, with subs hired and a 13-week line', async () => {
      assert.deepStrictEqual(d.topGcs.map((g) => [g.gc.name, g.jobs, g.subsHired]), [['Acme Builders LLC', 6, 2], ['Beta Homes Inc', 3, 3]]);
      assert.strictEqual(d.topGcs[0].weeks.length, 13);
      assert.strictEqual(d.topGcs[0].gc.phone.value, '+15125550100');
    });

    await check('latest building permits: newest first, individual withheld, trades listed', async () => {
      assert.strictEqual(d.recent[0].permitNumber, '2026-6 BP');
      assert.deepStrictEqual(d.recent[0].trades, []);
      const john = d.recent.find((r) => r.permitNumber === '2026-10 BP');
      assert.strictEqual(john.gc.name, null);
      assert.deepStrictEqual(john.trades, ['electrical']);
    });

    await check('map pins by ZIP, repeat hiring per trade, and no individual anywhere', async () => {
      assert.deepStrictEqual(d.map.pins.map((p) => [p.label, p.building]).sort(), [['78704', 6], ['78745', 4]]);
      assert.strictEqual(d.repeatHiring.electrical.eligibleHires > 0, true);
      const raw = JSON.stringify(d);
      assert.ok(!raw.includes('Smith') && !raw.includes('5550999'));
    });
  } finally {
    if (server) server.close();
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
