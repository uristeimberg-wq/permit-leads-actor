// Integration: the Leads screen's step-3 additions against a real database.
//   - permitType takes several types (`a|b`)
//   - ownerBuilder finds homeowner-pulled permits, never a missing contractor,
//     and shows no phone or owner
//   - `areas=a:TX` (a broad area) reaches rows with no city or ZIP
//   - saved permits: email sign-in, save, status/note, per-user lists, redaction
// Needs Postgres (DATABASE_URL; default :5433). Uses a throwaway database.

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_s_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000';
const row = (num, type, o = {}) => ({
  permit_number: `2026-${num} ${type}`, permittype: type, permit_type_desc: { BP: 'Building Permit', EP: 'Electrical Permit', PP: 'Plumbing Permit' }[type],
  description: 'Remodel kitchen', status_current: 'Active', issue_date: daysAgo(5), original_address1: `${num} MAIN ST`,
  original_city: 'AUSTIN', original_state: 'TX', original_zip: '78704',
  contractor_company_name: 'Acme Builders LLC', contractor_phone: '5125550100', total_job_valuation: '1000', ...o,
});
const rows = [
  row(1, 'BP'),
  row(2, 'EP', { contractor_company_name: 'Volt Electric LLC', contractor_phone: '5125550111' }),
  // Homeowner pulled it, written the way the data has it (Miami-Dade "OWNER").
  // Not "OWNER BUILDER": src/contractors.js partyKind reads BUILDER as a
  // business word, so that spelling keeps its phone (reported for a fix there).
  row(3, 'PP', { contractor_company_name: 'OWNER', contractor_phone: '5125550199' }),
  row(4, 'BP', { contractor_company_name: '', contractor_phone: '' }),                            // no contractor listed
  row(5, 'BP', { original_city: '', original_zip: '' }),                                          // no city or ZIP, state only
  row(6, 'EP', { original_city: 'RALEIGH', original_state: 'NC', original_zip: '27603' }),
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
  process.env.SESSION_SECRET = 'integration-test-secret';
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
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
    const { rows: ps } = await db.query('SELECT id, permit_number FROM permits ORDER BY permit_number');
    const id = (n) => String(ps.find((p) => p.permit_number.startsWith(`2026-${n} `)).id);

    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p, cookie) => { const r = await realFetch(base + p, { headers: cookie ? { cookie } : {} }); return { status: r.status, body: await r.json() }; };
    const send = (method, p, body, cookie) => realFetch(base + p, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    const total = async (q) => (await get(`/api/permits?stage=any&${q}`)).body.total;

    await check('permitType takes several types separated by |, and one as before', async () => {
      assert.strictEqual(await total('permitType=Building%20Permit'), 3);
      assert.strictEqual(await total('permitType=Electrical%20Permit'), 2);
      assert.strictEqual(await total('permitType=Building%20Permit%7CElectrical%20Permit'), 5);
    });

    await check('ownerBuilder: the homeowner-pulled permit only; no phone, no owner field', async () => {
      const { body } = await get('/api/permits?stage=any&ownerBuilder=true');
      assert.deepStrictEqual(body.results.map((r) => r.id), [id(3)], 'a missing contractor is not "the homeowner"');
      assert.strictEqual(body.results[0].contractor_phone, null);
      assert.ok(!('owner' in body.results[0]));
    });

    await check('a broad area (a:TX) reaches rows with no city or ZIP, alone or mixed', async () => {
      assert.strictEqual(await total('areas=c:AUSTIN%7CTX'), 4, 'by city, the city-less row is out');
      assert.strictEqual(await total('areas=a:TX'), 5, 'by area, it is in');
      assert.strictEqual(await total('areas=a:TX,z:27603'), 6);
      // Areas are offered from 50 permits up, so this tiny fixture offers none.
      const { body } = await get('/api/areas');
      assert.ok(Array.isArray(body.regions));
    });

    await check('/saved serves the Leads page', async () => {
      const r = await realFetch(`${base}/saved`);
      assert.strictEqual(r.status, 200);
      assert.match(await r.text(), /id="app"/);
    });

    await check('email sign-in, save, status and note, per-user lists, redaction', async () => {
      assert.strictEqual((await get('/api/me/saved')).status, 401);
      const si = await send('POST', '/api/me/signin', { email: 'Dana@Example.com' });
      assert.strictEqual(si.status, 200);
      const dana = (si.headers.get('set-cookie') || '').split(';')[0];

      assert.strictEqual((await send('PUT', `/api/me/saved/${id(3)}`, {}, dana)).status, 200);
      assert.strictEqual((await send('PUT', `/api/me/saved/${id(1)}`, { status: 'called', note: 'call back Tue' }, dana)).status, 200);
      assert.strictEqual((await send('PUT', '/api/me/saved/999999999', {}, dana)).status, 404);

      const { body } = await get('/api/me/saved', dana);
      assert.strictEqual(body.email, 'dana@example.com');
      const byId = Object.fromEntries(body.items.map((it) => [it.permitId, it]));
      assert.deepStrictEqual([byId[id(1)].status, byId[id(1)].note], ['called', 'call back Tue']);
      assert.strictEqual(byId[id(3)].permit.contractor_phone, null, 'the owner-builder phone stays hidden in the saved list');
      assert.ok(body.items.every((it) => !('owner' in it.permit) && !('applicant_name' in it.permit)));

      const sam = ((await send('POST', '/api/me/signin', { email: 'sam@example.com' })).headers.get('set-cookie') || '').split(';')[0];
      assert.deepStrictEqual((await get('/api/me', sam)).body.saved, [], 'another user sees nothing of Dana\'s');

      assert.strictEqual((await send('DELETE', `/api/me/saved/${id(1)}`, null, dana)).status, 200);
      assert.deepStrictEqual((await get('/api/me', dana)).body.saved.map((s) => s.permitId), [id(3)]);
      const { rows: [u] } = await db.query("SELECT count(*)::int AS n FROM app_users WHERE email = 'dana@example.com'");
      assert.strictEqual(u.n, 1, 'one user per email, stored lower-cased');
    });
  } finally {
    if (server) server.close();
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
