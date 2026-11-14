// Integration: planning cases through real ingests (ingest/run.js) against
// stubbed Socrata answers: cases upsert without duplicates, a status change
// writes one history row, parties keep their kind, and the property link to
// an Austin plan-review case is built and rebuilt idempotently. Also: a
// planning source never writes permits. Needs Postgres (DATABASE_URL; :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_pl_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const site = (rsn, o = {}) => ({
  folderrsn: rsn, case_type: 'Site Plan', case_name: `Project ${rsn}`, sub_type: 'Site Plan Administrative',
  status: 'Intake Pending', status_date: '2026-11-10T10:00:00.000', application_start_date: '2026-11-01T09:00:00.000',
  street_number: '100', street_name: 'MAIN', street_type: 'ST', propertyrsn: `P${rsn}`, tcad_id: '0123456789',
  owner_organization_name: 'KB HOME LONE STAR INC', applicant_organization_name: 'Jane Smith', proposed_no_of_units: '24',
  link: `https://abc.austintexas.gov/x?rsn=${rsn}`, ...o,
});
const pr = (num, propertyrsn, o = {}) => ({
  permit_number: `2026-${num} PR`, permit_type: 'Plan Review', sub_type: 'R- 101 Single Family Houses', folder_description: 'New house',
  folderrsn: `F${num}`, propertyrsn, status_current: 'In Review', applied_date: '2026-11-05T00:00:00.000', status_date: '2026-11-06T10:00:00.000',
  project_name: `${num} MAIN ST`, ...o,
});

const feeds = {
  'mavg-96ck': [site('1'), site('2', { propertyrsn: '0' }), site('3', { status: 'Closed' })],
  'n8ck-xkda': [pr(1, 'P1'), pr(2, 'P1', { applied_date: '2020-01-01T00:00:00.000' })],
};
global.fetch = async (url) => {
  const id = Object.keys(feeds).find((k) => String(url).includes(k));
  // Window queries ask for the same rows again; offset paging ends on a short page.
  return { ok: true, status: 200, json: async () => (String(url).includes('%24offset=0') || String(url).includes('$offset=0') ? feeds[id] : []), text: async () => '' };
};

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const { rebuildLinks } = require('../../ingest/planning.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  const run = (area) => ingestArea(area, { days: 30, max: 100, allDetails: false });
  try {
    await db.applySchema();
    await run('austin-plan-review-tx');
    await run('austin-site-plans-tx');

    await check('cases are stored with stage, refs and provenance; no permits are written', async () => {
      const rows = await q("SELECT * FROM planning_cases WHERE source_area = 'austin-site-plans-tx' ORDER BY case_number");
      assert.deepStrictEqual(rows.map((r) => [r.case_number, r.case_kind, r.lifecycle_stage, r.first_seen_stage]),
        [['1', 'site_plan', 'submitted', 'submitted'], ['2', 'site_plan', 'submitted', 'submitted'], ['3', 'site_plan', 'unknown', 'unknown']]);
      assert.strictEqual(rows[0].address_raw, '100 MAIN ST');
      assert.strictEqual(rows[0].units_proposed, 24);
      assert.strictEqual(rows[1].property_ref, null, 'propertyrsn "0" is a placeholder');
      assert.ok(rows.every((r) => r.latest_raw_record_id), 'every case points at its raw record');
      const [{ n }] = await q("SELECT count(*)::int AS n FROM permits WHERE source_area = 'austin-site-plans-tx'");
      assert.strictEqual(n, 0);
      const [{ role }] = await q("SELECT s.role FROM sources s WHERE s.slug = 'austin-site-plans-tx'");
      assert.strictEqual(role, 'planning');
    });

    await check('parties keep their kind; a person-shaped organisation is stored as individual', async () => {
      const rows = await q(`SELECT p.role, p.name, p.party_kind FROM planning_case_parties p JOIN planning_cases c ON c.id = p.case_id
                             WHERE c.case_number = '1' ORDER BY p.role`);
      assert.deepStrictEqual(rows.map((r) => [r.role, r.party_kind]), [['applicant', 'individual'], ['owner', 'business']]);
    });

    await check('a re-run writes nothing new; a status change writes one history row', async () => {
      await run('austin-site-plans-tx');
      const [{ n }] = await q('SELECT count(*)::int AS n FROM planning_cases');
      assert.strictEqual(n, 3);
      const before = await q("SELECT count(*)::int AS n FROM planning_case_status_history h JOIN planning_cases c ON c.id = h.case_id WHERE c.case_number = '1'");
      assert.strictEqual(before[0].n, 1);
      feeds['mavg-96ck'][0] = site('1', { status: 'In Review', status_date: '2026-11-12T10:00:00.000' });
      await run('austin-site-plans-tx');
      const hist = await q(`SELECT h.status_raw, h.lifecycle_stage, h.stage_since FROM planning_case_status_history h
                              JOIN planning_cases c ON c.id = h.case_id WHERE c.case_number = '1' ORDER BY h.id`);
      assert.deepStrictEqual(hist.map((h) => [h.status_raw, h.lifecycle_stage]), [['Intake Pending', 'submitted'], ['In Review', 'in_review']]);
      const [c] = await q("SELECT lifecycle_stage, first_seen_stage FROM planning_cases WHERE case_number = '1' AND source_area = 'austin-site-plans-tx'");
      assert.deepStrictEqual([c.lifecycle_stage, c.first_seen_stage], ['in_review', 'submitted'], 'first_seen_stage never moves');
      await run('austin-site-plans-tx');
      const again = await q("SELECT count(*)::int AS n FROM planning_case_status_history h JOIN planning_cases c ON c.id = h.case_id WHERE c.case_number = '1'");
      assert.strictEqual(again[0].n, 2);
    });

    await check('property link: plan-review case on the same propertyrsn, filed after the site plan, only', async () => {
      const first = await db.withTransaction(rebuildLinks);
      const second = await db.withTransaction(rebuildLinks);
      assert.deepStrictEqual(first, second, 'rebuild is idempotent');
      const links = await q(`SELECT c.case_number, p.permit_number, k.link_basis, k.confidence::float AS confidence
                               FROM planning_case_links k JOIN planning_cases c ON c.id = k.case_id JOIN permits p ON p.id = k.permit_id`);
      // 2026-2 PR shares the property but was filed years before the site plan.
      assert.deepStrictEqual(links.map((l) => [l.case_number, l.permit_number, l.link_basis, l.confidence]), [['1', '2026-1 PR', 'parcel_window', 0.6]]);
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.end();
  }
  if (failures) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
