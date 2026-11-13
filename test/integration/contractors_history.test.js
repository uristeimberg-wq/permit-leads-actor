// Integration: migration 004 (permit history, NULL valuation) and the
// contractor resolver, through real ingestArea and resolveAll calls against a
// stubbed Austin endpoint. Needs Postgres (DATABASE_URL; default :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_c_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const row = (num, type, company, phone, o = {}) => ({
  permit_number: `2026-${num} ${type}`, permittype: type, permit_type_desc: `${type} Permit`, description: 'Kitchen remodel',
  status_current: 'Active', issue_date: '2026-11-01T00:00:00.000', original_address1: `${num} MAIN ST`,
  original_city: 'AUSTIN', original_state: 'TX', original_zip: '78701',
  contractor_company_name: company, contractor_phone: phone, contractor_trade: null, ...o,
});

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
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); }
    catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  const sync = async (rows) => { pages = [rows]; await ingestArea('austin-tx', { days: 14, max: 100, allDetails: false }); };

  const first = [
    row(1, 'BP', 'Acme Builders LLC', '5125550100'),
    row(1, 'EP', 'Sparky Electric Inc', '5125550200', { issue_date: '2026-11-03T00:00:00.000' }),
    row(1, 'PP', 'Drip Plumbing', '5125550300'),
    row(2, 'BP', 'ACME BUILDERS, INC.', '512-555-0100'),
    row(2, 'EP', 'Sparky Electric', '5125550200', { issue_date: '2026-11-05T00:00:00.000' }),
    row(3, 'BP', 'OWNER', '5125550999'),
    row(4, 'BP', 'John Smith', '5125550444'),
  ];

  try {
    await db.applySchema();

    await check('missing valuation is stored as NULL, not 0', async () => {
      await sync(first);
      const r = await q("SELECT count(*) FILTER (WHERE valuation IS NULL)::int AS nulls, count(*) FILTER (WHERE valuation = 0)::int AS zeros FROM permits");
      assert.deepStrictEqual(r[0], { nulls: 7, zeros: 0 });
    });

    await check('every new permit gets version 1 and a first status entry', async () => {
      const [v] = await q('SELECT count(*)::int AS n FROM permit_versions');
      const [h] = await q('SELECT count(*)::int AS n FROM permit_status_history');
      assert.deepStrictEqual([v.n, h.n], [7, 7]);
    });

    await check('an unchanged re-sync adds no versions', async () => {
      await sync(first);
      const [v] = await q('SELECT count(*)::int AS n FROM permit_versions');
      assert.strictEqual(v.n, 7);
    });

    await check('a status change adds a version and a status-history entry', async () => {
      await sync(first.map((r) => (r.permit_number === '2026-1 BP' ? { ...r, status_current: 'Final' } : r)));
      const h = await q(`SELECT h.status_raw FROM permit_status_history h JOIN permits p ON p.id = h.permit_id
                          WHERE p.permit_number = '2026-1 BP' ORDER BY h.id`);
      assert.deepStrictEqual(h.map((x) => x.status_raw), ['Active', 'Final']);
      const [v] = await q("SELECT count(*)::int AS n FROM permit_versions v JOIN permits p ON p.id = v.permit_id WHERE p.permit_number = '2026-1 BP'");
      assert.strictEqual(v.n, 2);
    });

    let stats;
    await check('the resolver merges spellings, skips owner-builders, hides person-like phones', async () => {
      stats = await resolveAll();
      const cs = await q('SELECT display_name, permit_count, party_kind FROM contractors ORDER BY display_name');
      // Display name = the most-used spelling; ties go to the alphabetically first.
      assert.deepStrictEqual(cs.map((c) => [c.display_name, c.permit_count, c.party_kind]), [
        ['Acme Builders LLC', 2, 'business'], ['Drip Plumbing', 1, 'business'], ['John Smith', 1, 'individual'], ['Sparky Electric', 2, 'business'],
      ]);
      const [owner] = await q("SELECT match_rule, contractor_id FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id WHERE p.permit_number = '2026-3 BP'");
      assert.deepStrictEqual(owner, { match_rule: 'owner_builder', contractor_id: null });
      const [john] = await q("SELECT cp.display_policy FROM contact_points cp JOIN contractors c ON c.id = cp.contractor_id WHERE c.display_name = 'John Smith'");
      assert.strictEqual(john.display_policy, 'hide');
      assert.strictEqual(stats.byRule.owner_builder, 1);
    });

    await check('GC -> sub relationships come from shared permit-number bases', async () => {
      const rels = await q(`SELECT g.display_name AS gc, s.display_name AS sub, r.trade, r.jobs
                              FROM contractor_relationships r JOIN contractors g ON g.id = r.gc_id JOIN contractors s ON s.id = r.sub_id
                             ORDER BY r.trade`);
      assert.deepStrictEqual(rels, [
        { gc: 'Acme Builders LLC', sub: 'Sparky Electric', trade: 'electrical', jobs: 2 },
        { gc: 'Acme Builders LLC', sub: 'Drip Plumbing', trade: 'plumbing', jobs: 1 },
      ]);
    });

    await check('a second resolver run is identical and keeps contractor ids', async () => {
      const before = await q('SELECT id, identity_key FROM contractors ORDER BY id');
      const again = await resolveAll();
      const after = await q('SELECT id, identity_key FROM contractors ORDER BY id');
      assert.deepStrictEqual(after, before);
      assert.deepStrictEqual(again, stats);
      const runs = await q("SELECT status FROM resolver_runs ORDER BY id");
      assert.deepStrictEqual(runs.map((r) => r.status), ['succeeded', 'succeeded']);
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
