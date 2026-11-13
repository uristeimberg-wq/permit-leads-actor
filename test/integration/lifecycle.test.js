// Integration: lifecycle stages, official dates, status history and the
// plan-review -> building-permit link, through real Austin ingests against
// stubbed Socrata answers. Needs Postgres (DATABASE_URL; default :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_lc_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const bp = (num, o = {}) => ({
  permit_number: `2026-${num} BP`, permittype: 'BP', permit_type_desc: 'BP Permit', description: 'New single family',
  status_current: 'Active', issue_date: '2026-11-10T00:00:00.000', applieddate: '2026-09-01T00:00:00.000',
  statusdate: '2026-11-10T08:00:00.000', original_address1: `${num} MAIN ST`, original_city: 'AUSTIN', original_state: 'TX',
  original_zip: '78701', contractor_company_name: 'Acme Builders LLC', contractor_phone: '5125550100', ...o,
});
const pr = (num, rsn, o = {}) => ({
  permit_number: `2026-${num} PR`, permit_type: 'Plan Review', sub_type: 'R- 101 Single Family Houses', folder_description: 'New house',
  folderrsn: rsn, status_current: 'In Review', applied_date: '2026-09-01T00:00:00.000', status_date: '2026-10-01T10:00:00.000',
  project_name: `${num} MAIN ST`, web_link: { url: `https://abc.austintexas.gov/x?rsn=${rsn}` },
  location: { type: 'Point', coordinates: [-97.74, 30.27] }, ...o,
});

const feeds = {
  '3syk-w9eu': [bp(1, { masterpermitnum: '111' }), bp(2, { masterpermitnum: '999' }), bp(3, { status_current: 'Pending' })],
  'n8ck-xkda': [pr(1, '111'), pr(4, '444', { status_current: 'Intake Pending' }), pr(5, '555', { status_current: 'Brand New Word', project_name: 'Barton Market' })],
};
global.fetch = async (url) => {
  const id = Object.keys(feeds).find((k) => String(url).includes(k));
  return { ok: true, status: 200, json: async () => feeds[id], text: async () => '' };
};

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const { runLifecycle } = require('../../ingest/lifecycle.js');
  const { SOURCES } = require('../../src/sources.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  const permit = async (n) => (await q('SELECT * FROM permits WHERE permit_number = $1', [n]))[0];
  const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  const ingestBoth = async () => {
    await ingestArea('austin-tx', { days: 30, max: 100, allDetails: false });
    await ingestArea('austin-plan-review-tx', { days: 30, max: 100, allDetails: false });
  };
  try {
    await db.applySchema();
    await ingestBoth();

    await check('each filing carries its stage, official dates and the stage we first saw', async () => {
      const a = await permit('2026-1 PR');
      assert.deepStrictEqual([a.filing_kind, a.lifecycle_stage, a.first_seen_stage, a.status_stage, iso(a.submitted_on), iso(a.stage_since)],
        ['building_application', 'in_review', 'in_review', 'pending', '2026-09-01', '2026-10-01']);
      assert.strictEqual(a.permit_url, 'https://abc.austintexas.gov/x?rsn=111');
      const b = await permit('2026-1 BP');
      assert.deepStrictEqual([b.filing_kind, b.lifecycle_stage, iso(b.submitted_on), iso(b.filed_date)], [null, 'issued', '2026-09-01', '2026-11-10']);
      // An issued-feed 'Pending' says nothing about the stage: unknown, not guessed.
      assert.strictEqual((await permit('2026-3 BP')).lifecycle_stage, 'unknown');
      assert.strictEqual((await permit('2026-5 PR')).address, null); // a project title is not an address
    });

    await check('the plan-review GeoJSON point is a source point', async () => {
      const { sourcePoints } = require('../../ingest/geocode.js');
      const pts = await sourcePoints();
      const [{ id }] = await q("SELECT id FROM permits WHERE permit_number = '2026-1 PR'");
      assert.deepStrictEqual(pts.filter((x) => x.permitId === String(id)).map((x) => [x.lat, x.lng]), [[30.27, -97.74]]);
    });

    await check('the link follows masterpermitnum = folderrsn, and only that', async () => {
      const s = await runLifecycle();
      assert.deepStrictEqual(s.linked, { 'austin-plan-review-tx': 1 });
      const links = await q(`SELECT f.permit_number AS f, t.permit_number AS t, k.link_basis, k.confidence::text FROM permit_links k
        JOIN permits f ON f.id = k.from_permit_id JOIN permits t ON t.id = k.to_permit_id`);
      assert.deepStrictEqual(links, [{ f: '2026-1 PR', t: '2026-1 BP', link_basis: 'official_reference', confidence: '1.00' }]);
      const l = s.links[0];
      assert.deepStrictEqual([l.applications, l.linked_applications, l.median_days_submitted_to_issued], [3, 1, 70]);
      assert.deepStrictEqual(s.unknown.map((u) => [u.source_area, u.status_raw]),
        [['austin-plan-review-tx', 'Brand New Word'], ['austin-tx', 'Pending']]);
    });

    await check('a status change is a history row with its stage; the first-seen stage stays', async () => {
      feeds['n8ck-xkda'][0] = pr(1, '111', { status_current: 'Approved', status_date: '2026-11-05T10:00:00.000' });
      await ingestBoth();
      const a = await permit('2026-1 PR');
      assert.deepStrictEqual([a.lifecycle_stage, a.first_seen_stage, a.status_stage, iso(a.stage_since)], ['approved', 'in_review', 'pending', '2026-11-05']);
      const h = await q('SELECT status_raw, lifecycle_stage, stage_since FROM permit_status_history WHERE permit_id = $1 ORDER BY id', [a.id]);
      assert.deepStrictEqual(h.map((r) => [r.status_raw, r.lifecycle_stage, iso(r.stage_since)]),
        [['In Review', 'in_review', '2026-10-01'], ['Approved', 'approved', '2026-11-05']]);
    });

    await check('a vocabulary fix restages held rows and history without new history rows', async () => {
      SOURCES['austin-plan-review-tx'].lifecycle.statuses['brand new word'] = 'submitted';
      const before = (await q('SELECT count(*)::int AS n FROM permit_status_history'))[0].n;
      const s = await runLifecycle();
      assert.deepStrictEqual([s.restaged.permits, s.restaged.history], [1, 1]);
      assert.strictEqual((await permit('2026-5 PR')).lifecycle_stage, 'submitted');
      assert.strictEqual((await q('SELECT count(*)::int AS n FROM permit_status_history'))[0].n, before);
      delete SOURCES['austin-plan-review-tx'].lifecycle.statuses['brand new word'];
    });

    await check('rows from before 017 get their official dates from raw records; a re-run changes nothing', async () => {
      await q("UPDATE permits SET submitted_on = NULL, stage_since = NULL, first_seen_stage = NULL WHERE permit_number = '2026-2 BP'");
      const s = await runLifecycle();
      assert.deepStrictEqual(s.dates, { submittedOn: 1, stageSince: 1 });
      const b = await permit('2026-2 BP');
      assert.deepStrictEqual([iso(b.submitted_on), iso(b.stage_since), b.first_seen_stage], ['2026-09-01', '2026-11-10', null]);
      const again = await runLifecycle();
      assert.deepStrictEqual([again.restaged, again.dates, again.linked],
        [{ permits: 0, history: 0 }, { submittedOn: 0, stageSince: 0 }, { 'austin-plan-review-tx': 1 }]);
      assert.strictEqual((await q('SELECT count(*)::int AS n FROM permit_links'))[0].n, 1);
    });

    await check('the job API shows the application behind a permit, with its own dates and history', async () => {
      const { getJob, parseFilters } = require('../../db/pilot_queries.js');
      const { id } = await permit('2026-1 BP');
      const { lifecycle: l } = await getJob(id, parseFilters({ trade: 'electrical', source: 'austin-tx' }));
      assert.deepStrictEqual([l.stage, l.applications.length], ['issued', 1]);
      const [a] = l.applications;
      assert.deepStrictEqual([a.permitNumber, a.stage, a.firstSeenStage, a.submittedOn, a.link.basis, a.link.confidence],
        ['2026-1 PR', 'approved', 'in_review', '2026-09-01', 'official_reference', 1]);
      assert.deepStrictEqual(a.history.map((h) => h.stage), ['in_review', 'approved']);
      assert.ok(!JSON.stringify(l).match(/applicant|owner/i), 'a person field reached the API');
    });

    await check('the Early screen lists Austin applications not issued yet, and nothing for issued-only markets', async () => {
      const { listEarly, parseFilters, SOURCES } = require('../../db/pilot_queries.js');
      assert.deepStrictEqual(SOURCES, ['austin-tx', 'miami-dade-fl', 'miami-city-fl', 'raleigh-nc']);
      const e = await listEarly(parseFilters({ source: 'austin-tx' }), { days: 400 });
      assert.strictEqual(e.available, true);
      const one = e.filings.find((r) => r.permit_number === '2026-1 PR');
      assert.deepStrictEqual([one.stage, one.submittedOn, one.contractor], ['approved', '2026-09-01', null]);
      assert.ok(one.issuedPermitId, 'the linked permit is offered');
      assert.ok(!e.filings.some((r) => r.permit_number.endsWith('BP')), 'an issued permit was listed');
      assert.ok(!JSON.stringify(e).match(/applicant|owner/i));
      assert.deepStrictEqual((await listEarly(parseFilters({ source: 'miami-dade-fl' }))).available, false);
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.end();
  }
  if (failures) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
