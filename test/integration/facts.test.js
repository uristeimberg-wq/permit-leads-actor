// Integration: building facts (migration 020, ingest/facts.js) from real
// Austin ingests against a stubbed Socrata answer. Re-runs write nothing new
// and never duplicate; a changed raw record updates the one row. Needs
// Postgres (DATABASE_URL; default :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_facts_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const bp = (num, o = {}) => ({
  permit_number: `2026-${num} BP`, permittype: 'BP', permit_type_desc: 'BP Permit', description: 'New single family',
  status_current: 'Active', issue_date: '2026-11-10T00:00:00.000', applieddate: '2026-09-01T00:00:00.000',
  statusdate: '2026-11-10T08:00:00.000', original_address1: `${num} MAIN ST`, original_city: 'AUSTIN', original_state: 'TX',
  original_zip: '78701', contractor_company_name: 'Acme Builders LLC', contractor_phone: '5125550100',
  housing_units: '1', number_of_floors: '2', total_new_add_sqft: '2440', project_id: `P${num}`,
  link: { url: `https://abc.austintexas.gov/web/permit/public-search-other?t_detail=1&t_selected_folderrsn=${num}` }, ...o,
});
let feed = [bp(1), bp(2, { number_of_floors: '0', housing_units: null })];
global.fetch = async () => ({ ok: true, status: 200, json: async () => feed, text: async () => '' });

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const { runFacts } = require('../../ingest/facts.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  const facts = async (n) => (await q('SELECT f.* FROM permit_facts f JOIN permits p ON p.id = f.permit_id WHERE p.permit_number = $1', [n]))[0];
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  try {
    await db.applySchema();
    await ingestArea('austin-tx', { days: 30, max: 100, allDetails: false });
    const first = await runFacts();

    await check('one facts row per permit, traced to its raw record', async () => {
      assert.strictEqual(first.stats['austin-tx'].written, 2);
      const a = await facts('2026-1 BP');
      assert.deepStrictEqual([a.units, Number(a.floors), Number(a.new_sqft), a.project_ref, a.facts_version], [1, 2, 2440, 'P1', 'facts-v1']);
      const [{ ok }] = await q(`SELECT count(*)::int AS ok FROM permit_facts f JOIN raw_records r ON r.id = f.raw_record_id`);
      assert.strictEqual(ok, 2);
    });

    await check('missing and placeholder values are NULL', async () => {
      const b = await facts('2026-2 BP');
      assert.deepStrictEqual([b.units, b.floors], [null, null]);
    });

    await check('a re-run writes nothing and duplicates nothing', async () => {
      const again = await runFacts();
      assert.strictEqual(again.stats['austin-tx'].written, 0);
      const [{ n }] = await q('SELECT count(*)::int AS n FROM permit_facts');
      assert.strictEqual(n, 2);
    });

    await check('a changed source record updates the one row', async () => {
      feed = [bp(1, { number_of_floors: '3' }), feed[1]];
      await ingestArea('austin-tx', { days: 30, max: 100, allDetails: false });
      const r = await runFacts();
      assert.strictEqual(r.stats['austin-tx'].written, 1);
      assert.strictEqual(Number((await facts('2026-1 BP')).floors), 3);
      const [{ n }] = await q('SELECT count(*)::int AS n FROM permit_facts');
      assert.strictEqual(n, 2);
    });

    await check('scorecard: one row per market, metric and day; a re-run replaces, never duplicates', async () => {
      const { runScorecard } = require('../../ingest/scorecard.js');
      const first = await runScorecard();
      assert.deepStrictEqual(first.failed, []);
      const [{ n }] = await q('SELECT count(*)::int AS n FROM scorecard_snapshots');
      assert.ok(n > 0);
      await runScorecard();
      const [{ n: again }] = await q('SELECT count(*)::int AS n FROM scorecard_snapshots');
      assert.strictEqual(again, n);
      const [link] = await q("SELECT value FROM scorecard_snapshots WHERE metric = 'official_link' AND market = 'austin-tx'");
      assert.strictEqual(Number(link.value), 1);
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.end();
  }
  if (failures) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
