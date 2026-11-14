// Integration: the estimates (ADR-21) over real ingests of stubbed Austin
// answers: issue forecasts on the Early screen, trade timing on the job page,
// and builder momentum. Needs Postgres (DATABASE_URL; default :5433).

// The estimates are hidden from the API by default (web/trust.js,
// docs/DATA_TRUST_AUDIT.md); this suite checks the estimates themselves.
process.env.SHOW_INFERENCES = '1';

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_insights_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const ago = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000';
const R101 = 'R- 101 Single Family Houses';
let n = 1000;
const bp = (company, issuedAgo, reviewDays, o = {}) => {
  n += 1;
  return {
    permit_number: `2025-${n} BP`, permittype: 'BP', permit_type_desc: 'Building Permit', permit_class: R101, work_class: 'New',
    description: 'New single family residence', status_current: 'Active', issue_date: ago(issuedAgo), applieddate: ago(issuedAgo + reviewDays),
    statusdate: ago(issuedAgo), original_address1: `${n} MAIN ST`, original_city: 'AUSTIN', original_state: 'TX', original_zip: '78704',
    contractor_company_name: company, contractor_phone: company === 'Jane Doe' ? '5125550999' : `512555${String(n).slice(-4)}`, ...o,
  };
};
// A trade permit on the same job, issued `afterDays` after its building permit.
const trade = (bpRow, issuedAgo, type, afterDays, company) => ({
  ...bpRow, permit_number: bpRow.permit_number.replace(' BP', ` ${type}`), permittype: type, permit_type_desc: `${type} Permit`,
  permit_class: 'Residential', description: 'Trade work', issue_date: ago(issuedAgo - afterDays),
  contractor_company_name: company, contractor_phone: '5125550200',
});

const rows = [];
// Acme: ten jobs watched for the full horizon; electrical followed 20 days after on eight.
const acmeAgo = [210, 230, 250, 270, 290, 310, 330, 350, 370, 390];
acmeAgo.forEach((a, i) => {
  const b = bp('Acme Builders LLC', a, 60);
  rows.push(b);
  if (i < 8) rows.push(trade(b, a, 'EP', 20, 'Sparky Electric Inc'));
});
// The rest of the market: 15 new houses with review times of 30..100 days.
for (let i = 0; i < 15; i++) rows.push(bp(`Other Homes ${i} LLC`, 200 + i * 10, 30 + i * 5));
// Rising Homes: six jobs in the last 90 days, one in the 90 before.
for (const a of [5, 15, 25, 35, 45, 55]) rows.push(bp('Rising Homes LLC', a, 45));
rows.push(bp('Rising Homes LLC', 120, 45));
// Slowing Builders: none recently, five in the earlier window.
for (const a of [100, 110, 120, 130, 140]) rows.push(bp('Slowing Builders Inc', a, 40));
// An individual with a rising volume: never listed.
for (const a of [10, 20, 30, 40]) rows.push(bp('Jane Doe', a, 30));
// A fresh Acme job with no trade permit yet: the job page's outlook.
const fresh = bp('Acme Builders LLC', 5, 50);
rows.push(fresh);
// Something older than our window so history covers the earlier 90 days.
rows.push(bp('Old Timer Construction LLC', 500, 30));

const cases = [
  { permit_number: '2026-9001 PR', permit_type: 'Plan Review', sub_type: R101, work_class: 'New', folder_description: 'New house',
    folderrsn: '9001', status_current: 'In Review', applied_date: ago(10), status_date: ago(5), project_name: '9001 OAK ST',
    other_organization_name: 'Rising Homes LLC' },
  { permit_number: '2026-9002 PR', permit_type: 'Plan Review', sub_type: 'R- 999 Something Unusual', work_class: 'New', folder_description: 'Odd',
    folderrsn: '9002', status_current: 'In Review', applied_date: ago(3), status_date: ago(2), project_name: '9002 OAK ST' },
  { permit_number: '2026-9003 PR', permit_type: 'Plan Review', sub_type: R101, work_class: 'New', folder_description: 'Old case',
    folderrsn: '9003', status_current: 'In Review', applied_date: ago(85), status_date: ago(2), project_name: '9003 OAK ST' },
];

const feeds = { '3syk-w9eu': rows, 'n8ck-xkda': cases };
const realFetch = global.fetch;
global.fetch = async (url) => {
  const id = Object.keys(feeds).find((k) => String(url).includes(k));
  return { ok: true, status: 200, json: async () => (id ? feeds[id] : []), text: async () => '' };
};

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  process.env.API_CACHE = 'off';
  delete process.env.DEMO_PASSWORD;
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const { resolveAll } = require('../../ingest/resolve.js');
  const { runLifecycle } = require('../../ingest/lifecycle.js');
  const { runFilers } = require('../../ingest/filers.js');
  const { app } = require('../../web/server.js');
  let server;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  try {
    await db.applySchema();
    await ingestArea('austin-tx', { days: 600, max: 1000, allDetails: false });
    await ingestArea('austin-plan-review-tx', { days: 600, max: 100, allDetails: false });
    await resolveAll();
    await runLifecycle();
    await runFilers();
    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p) => { const r = await realFetch(base + p); return { status: r.status, body: await r.json() }; };

    const early = (await get('/api/pilot/early?source=austin-tx&days=90&segment=all')).body;
    const byNum = Object.fromEntries(early.filings.map((x) => [x.permit_number, x]));

    await check('a new-house filing gets a window from new houses, conditional on its age', async () => {
      const fc = byNum['2026-9001 PR'].issueForecast;
      assert.strictEqual(fc.status, 'ok');
      assert.strictEqual(fc.basis.basis, 'class');
      // Issued in the last 12 months, all R-101: 8 Acme (two are older) + 15 others
      // + 7 Rising + 5 Slowing + 4 individual + 1 fresh.
      assert.strictEqual(fc.n, 40);
      assert.ok(fc.nAtAge <= fc.n && fc.ageDays === 10);
      assert.ok(fc.lowDays <= fc.midDays && fc.midDays <= fc.highDays && fc.lowDays >= 0);
      assert.ok(fc.lowOn <= fc.midOn && fc.midOn <= fc.highOn);
    });

    await check('a class we have too few of falls back to every building permit, and says so', async () => {
      const fc = byNum['2026-9002 PR'].issueForecast;
      assert.strictEqual(fc.basis.basis, 'all');
      assert.strictEqual(fc.status, 'ok');
    });

    await check('a filing older than nearly every comparable gets no window', async () => {
      assert.strictEqual(byNum['2026-9003 PR'].issueForecast.status, 'overdue');
    });

    const [freshRow] = (await db.query('SELECT id FROM permits WHERE permit_number = $1', [fresh.permit_number])).rows;
    const job = (await get(`/api/pilot/jobs/${freshRow.id}?trade=electrical`)).body;

    await check("trade timing on a fresh job reads the builder's own history", async () => {
      const e = job.tradeOutlook.electrical;
      assert.strictEqual(e.basis.basis, 'builder');
      assert.deepStrictEqual([e.status, e.n, e.withTrade, e.likelihood], ['ok', 10, 8, 0.8]);
      // Every past electrical permit came 20 days after the BP; this BP is 5 days old.
      assert.deepStrictEqual([e.lowDays, e.midDays, e.highDays], [15, 15, 15]);
    });

    await check('a trade this builder never permitted reads as unlikely, with no window', async () => {
      const m = job.tradeOutlook.mechanical;
      assert.deepStrictEqual([m.status, m.likelihood, m.midDays], ['ok', 0, null]);
    });

    await check('no outlook for a trade already permitted on the job', async () => {
      const [old] = (await db.query("SELECT p.id FROM permits p WHERE p.permit_number LIKE '% BP' AND EXISTS (SELECT 1 FROM permits e WHERE e.permit_number = replace(p.permit_number, ' BP', ' EP')) LIMIT 1")).rows;
      const j = (await get(`/api/pilot/jobs/${old.id}?trade=electrical`)).body;
      assert.ok(!('electrical' in j.tradeOutlook));
    });

    const mo = (await get('/api/pilot/momentum?source=austin-tx')).body;
    const byName = Object.fromEntries(mo.builders.map((b) => [b.builder.name, b]));

    await check('momentum: rising and slowing builders, with the counts behind the label', async () => {
      assert.strictEqual(mo.historyCovers, true);
      assert.deepStrictEqual([byName['Rising Homes LLC'].trend, byName['Rising Homes LLC'].recent, byName['Rising Homes LLC'].prior], ['rising', 6, 1]);
      assert.deepStrictEqual([byName['Slowing Builders Inc'].trend, byName['Slowing Builders Inc'].recent, byName['Slowing Builders Inc'].prior], ['slowing', 0, 5]);
      assert.strictEqual(mo.builders[0].builder.name, 'Rising Homes LLC');
    });

    await check("momentum counts the builder's applications still in review", async () => {
      assert.deepStrictEqual(byName['Rising Homes LLC'].applications, { filed: 1, inReview: 1 });
    });

    await check('momentum never lists an individual', async () => {
      assert.ok(!JSON.stringify(mo).includes('Jane Doe'));
      assert.ok(!JSON.stringify(mo).includes('5125550999'));
    });

    await check('momentum withholds the change when history does not cover the earlier window', async () => {
      const w = (await get('/api/pilot/momentum?source=austin-tx&window=180')).body;
      // History starts ~500 days ago at the 1st percentile; 2 x 180 is covered, so force a gap instead.
      await db.query("DELETE FROM permit_parties WHERE issued_on < current_date - 150");
      const g = (await get('/api/pilot/momentum?source=austin-tx&window=90')).body;
      assert.strictEqual(w.historyCovers, true);
      assert.strictEqual(g.historyCovers, false);
      assert.ok(g.builders.every((b) => b.trend === 'unknown' && b.change === null));
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
