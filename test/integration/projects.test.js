// Integration: projects (/api/projects, /api/projects/by-permit/:id) against a
// real database, with inferences on (same-address grouping and stages) and
// off (official numbers only). Needs Postgres (DATABASE_URL; default :5433).
// Uses a throwaway database.

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_p_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000';
const row = (num, type, o = {}) => ({
  permit_number: `2026-${num} ${type}`, permittype: type,
  permit_type_desc: { BP: 'Building Permit', EP: 'Electrical Permit', PP: 'Plumbing Permit' }[type],
  description: 'New construction 3-unit residential', status_current: 'Active', issue_date: daysAgo(5),
  original_address1: '2501 BRYAN ST', original_city: 'AUSTIN', original_state: 'TX', original_zip: '78702',
  contractor_company_name: 'Acme Builders LLC', contractor_phone: '5125550100', total_job_valuation: '300000', ...o,
});
const rows = [
  row(107243, 'BP', { original_address1: '2501 BRYAN ST BLDG 1' }),
  row(107245, 'BP', { original_address1: '2501 BRYAN ST BLDG 3', total_job_valuation: '300000' }),       // same value: counted once
  row(107243, 'EP', { original_address1: '2501 BRYAN ST BLDG 1', contractor_company_name: 'Volt Electric LLC', contractor_phone: '5125550111', total_job_valuation: '' }),
  row(200001, 'EP', { original_address1: '9 ELM ST', description: 'Home builders loop\nRef: 2026-107245 BP', contractor_company_name: 'Spark LLC', contractor_phone: '5125550122', total_job_valuation: '' }),
];

const realFetch = global.fetch;
let pages = [];
global.fetch = async () => { const page = pages.shift() || []; return { ok: true, json: async () => page, text: async () => '' }; };

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
    // Job links come from the resolver (permit_parties.job_key).
    await resolveAll();
    const { rows: ps } = await db.query('SELECT id, permit_number FROM permits');
    const id = (n) => String(ps.find((p) => p.permit_number === n).id);

    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p) => { const r = await realFetch(base + p); return { status: r.status, body: await r.json() }; };

    await check('inferences off: official numbers and Ref links only, no stage', async () => {
      delete process.env.SHOW_INFERENCES;
      const { body } = await get('/api/projects?stage=any');
      assert.strictEqual(body.inferences, false);
      assert.strictEqual(body.permitsMatched, 4);
      // BP 107243 + its EP; BP 107245 + the EP that says "Ref: 2026-107245 BP".
      assert.deepStrictEqual(body.results.map((r) => r.permitCount).sort(), [2, 2]);
      assert.ok(body.results.every((r) => r.stage === null));
      const one = (await get(`/api/projects/by-permit/${id('2026-107243 BP')}`)).body;
      assert.deepStrictEqual(one.permits.map((p) => p.permit_number).sort(), ['2026-107243 BP', '2026-107243 EP']);
    });

    await check('inferences on: BLDG 1 and BLDG 3 join by address; value counted once; stage shown', async () => {
      process.env.SHOW_INFERENCES = '1';
      const { body } = await get('/api/projects?stage=any');
      assert.strictEqual(body.total, 1);
      const pr = body.results[0];
      assert.strictEqual(pr.address, '2501 BRYAN ST');
      assert.deepStrictEqual(pr.buildings.sort(), ['Bldg 1', 'Bldg 3']);
      assert.strictEqual(pr.permitCount, 4);
      assert.strictEqual(pr.value.total, 300000, 'the repeated $300K counted once');
      assert.strictEqual(pr.phones.length, 3);
      assert.strictEqual(pr.stage, 'Rough-in (MEP)');
      const one = (await get(`/api/projects/by-permit/${id('2026-200001 EP')}`)).body;
      assert.strictEqual(one.permitCount, 4, 'the Ref permit opens the whole project');
    });

    await check('a bad or unknown permit id', async () => {
      assert.strictEqual((await get('/api/projects/by-permit/abc')).status, 400);
      assert.strictEqual((await get('/api/projects/by-permit/999999999')).status, 404);
    });
  } finally {
    delete process.env.SHOW_INFERENCES;
    if (server) server.close();
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
