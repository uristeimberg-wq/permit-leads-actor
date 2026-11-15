// Integration: the search map (/api/map, /api/map/points, /api/areas) places
// areas by their located job sites, so a market missing from the committed
// area file (Raleigh) still appears, and job sites come back with their method.
// Needs Postgres (DATABASE_URL; default :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_m_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000';
const row = (num, zip, o = {}) => ({
  permit_number: `2026-${num} BP`, permittype: 'BP', permit_type_desc: 'Building Permit', description: 'Remodel kitchen',
  status_current: 'Active', issue_date: daysAgo(5), original_address1: `${num} MAIN ST`,
  original_city: 'AUSTIN', original_state: 'TX', original_zip: zip,
  contractor_company_name: 'Acme Builders LLC', contractor_phone: '5125550100', total_job_valuation: '1000', ...o,
});
// 78704 is in data/area-coords.json; 27603 (a Raleigh code) is not.
const rows = [row(1, '78704'), row(2, '78704'), row(3, '27603', { original_city: 'RALEIGH', original_state: 'NC' }), row(4, '99999', { original_city: 'NOWHERE', original_state: 'ZZ' })];

const realFetch = global.fetch;
let pages = [];
global.fetch = async () => { const page = pages.shift() || []; return { ok: true, json: async () => page, text: async () => '' }; };

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  delete process.env.DEMO_PASSWORD;
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
    const id = (n) => ps.find((p) => p.permit_number === `2026-${n} BP`).id;
    const { rows: [run] } = await db.query('SELECT max(id) AS id FROM sync_runs');
    // Two Austin job sites (one an approximate Census match) and one in Raleigh; #4 is not located.
    await db.query(`INSERT INTO permit_locations (permit_id, lat, lng, method, quality, sync_run_id) VALUES
      ($1, 30.2450, -97.7650, 'source', NULL, $4), ($2, 30.2460, -97.7660, 'census', 'non_exact', $4), ($3, 35.7500, -78.6500, 'parcel', NULL, $4)`,
    [id(1), id(2), id(3), run.id]);

    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p) => { const r = await realFetch(base + p); return { status: r.status, body: await r.json() }; };

    await check('pins sit on their job sites; Raleigh places though the area file lacks it', async () => {
      const { body } = await get('/api/map?stage=any');
      const pins = Object.fromEntries(body.pins.map((p) => [p.key, p]));
      assert.strictEqual(pins['z:78704'].permits, 2);
      assert.strictEqual(pins['z:78704'].basis, 'job_sites');
      assert.ok(Math.abs(pins['z:78704'].lat - 30.2455) < 1e-6, 'median of the two job sites');
      assert.strictEqual(pins['z:27603'].basis, 'job_sites');
      assert.strictEqual(body.unplaced, 1, 'the permit with no place is counted, not dropped');
    });

    await check('the picker offers the Raleigh ZIP and not the unplaceable one', async () => {
      const { body } = await get('/api/areas');
      assert.deepStrictEqual(body.zips.map((z) => z.zip).sort(), ['27603', '78704']);
      assert.strictEqual(body.zipsHidden, 1);
    });

    await check('job sites in a viewport, with how each was located, filters applied', async () => {
      const { status, body } = await get('/api/map/points?stage=any&bbox=30.2,-97.8,30.3,-97.7');
      assert.strictEqual(status, 200);
      // A Census point is unmeasured (ADR-32): left out unless SHOW_UNMEASURED=1.
      assert.strictEqual(body.inView, 1);
      assert.deepStrictEqual(body.points.map((p) => p.method), ['source']);
      process.env.SHOW_UNMEASURED = '1';
      const all = (await get('/api/map/points?stage=any&bbox=30.2,-97.8,30.3,-97.7')).body;
      delete process.env.SHOW_UNMEASURED;
      assert.strictEqual(all.inView, 2);
      assert.deepStrictEqual(all.points.map((p) => p.method).sort(), ['census', 'source']);
      assert.strictEqual(all.points.find((p) => p.method === 'census').quality, 'non_exact');
      const none = await get('/api/map/points?stage=any&zip=27603&bbox=30.2,-97.8,30.3,-97.7');
      assert.strictEqual(none.body.inView, 0);
    });

    await check('a viewport wider than a city, or malformed, is refused', async () => {
      assert.strictEqual((await get('/api/map/points?bbox=29,-99,31,-97')).status, 400);
      assert.strictEqual((await get('/api/map/points?bbox=a,b,c,d')).status, 400);
      assert.strictEqual((await get('/api/map/points')).status, 400);
    });

    await check('search results and the permit record carry the located point, or null', async () => {
      const { body } = await get('/api/permits?stage=any&zip=78704&sort=oldest');
      assert.strictEqual(body.results[0].location.method, 'source');
      const one = await get(`/api/permits/${id(4)}`);
      assert.strictEqual(one.body.location, null);
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
