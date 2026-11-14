// Integration: who filed each Austin application (ADR-19), through real
// ingests against stubbed Socrata answers, then the Early screen's API.
// Needs Postgres (DATABASE_URL; default :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_filers_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const recent = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000';
const bp = (num, o = {}) => ({
  permit_number: `2026-${num} BP`, permittype: 'BP', permit_type_desc: 'BP Permit', description: 'New single family',
  status_current: 'Active', issue_date: recent(3), applieddate: recent(20), statusdate: recent(3),
  original_address1: `${num} MAIN ST`, original_city: 'AUSTIN', original_state: 'TX', original_zip: '78701',
  contractor_company_name: 'Acme Builders LLC', contractor_phone: '5125550100', ...o,
});
const trade = (num, type, name) => bp(num, { permit_number: `2026-${num} ${type}`, permittype: type, description: `${type} work`, contractor_company_name: name, contractor_phone: '5125550199' });
const pr = (num, rsn, o = {}) => ({
  permit_number: `2026-${num} PR`, permit_type: 'Plan Review', sub_type: 'R- 101 Single Family Houses', work_class: 'New',
  folder_description: 'New house', folderrsn: rsn, status_current: 'In Review', applied_date: recent(10), status_date: recent(5),
  project_name: `${num} OAK ST`, web_link: { url: `https://abc.austintexas.gov/x?rsn=${rsn}` },
  location: { type: 'Point', coordinates: [-97.74, 30.27] }, ...o,
});

const PEOPLE = ['Jane Doe', 'Jane Roe', 'Smith Family Trust', 'John Q Public'];
const feeds = {
  '3syk-w9eu': [
    bp(1, { masterpermitnum: '111' }), trade(1, 'EP', 'Sparky Electric LLC'), trade(1, 'PP', 'Pipe Plumbing Inc'),
    bp(6, { masterpermitnum: '666' }), trade(6, 'EP', 'Sparky Electric LLC'),
    bp(7, { masterpermitnum: '777', contractor_company_name: 'Other Homes LLC' }),
  ],
  'n8ck-xkda': [
    pr(1, '111', { other_organization_name: 'Acme Builders LLC *MAIN*', owner_organization_name: 'Smith Family Trust',
      applicant_full_name: 'Jane Doe', owner_full_name: 'John Q Public', applicant_phone: '5125550111' }),
    pr(6, '666', { applicant_organization_name: 'ACME BUILDERS' }),
    pr(2, '777', { other_organization_name: 'Aqua Permits', applicant_full_name: 'Jane Doe' }),
    pr(3, '333', { other_organization_name: 'LOOP LAND LP', owner_organization_name: 'Loop Land LP' }),
    pr(4, '444', { other_organization_name: 'Jane Roe' }),
    pr(5, '555', { sub_type: 'R- 105 Five or More Family Bldgs', other_organization_name: 'Big Apartments Development' }),
    pr(8, '888', { other_organization_name: 'Other Homes LLC' }),
  ],
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
  const { resolveAll } = require('../../ingest/resolve.js');
  const { runLifecycle } = require('../../ingest/lifecycle.js');
  const { runFilers } = require('../../ingest/filers.js');
  const { listEarly, parseFilters } = require('../../db/pilot_queries.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  try {
    await db.applySchema();
    await ingestArea('austin-tx', { days: 30, max: 100, allDetails: false });
    await ingestArea('austin-plan-review-tx', { days: 30, max: 100, allDetails: false });
    await resolveAll();
    await runLifecycle();
    const first = await runFilers();

    await check('filers come from the organisation fields only; owner orgs and people never stored', async () => {
      const rows = await q('SELECT p.permit_number, ff.source_field, ff.raw_name, ff.org_key FROM filing_filers ff JOIN permits p ON p.id = ff.permit_id ORDER BY 1');
      assert.deepStrictEqual(rows.map((r) => [r.permit_number, r.org_key]), [
        ['2026-1 PR', 'acme builders'], ['2026-2 PR', 'aqua permits'], ['2026-4 PR', 'jane roe'],
        ['2026-5 PR', 'big apartments development'], ['2026-6 PR', 'acme builders'], ['2026-8 PR', 'other homes'],
      ]);
      const all = JSON.stringify(await q('SELECT * FROM filing_filers')) + JSON.stringify(await q('SELECT * FROM filer_orgs'));
      for (const p of ['Jane Doe', 'Smith Family Trust', 'John Q Public', 'Loop Land', '5125550111']) assert.ok(!all.includes(p), `${p} stored`);
    });

    await check('builders, expediters and unknowns, each with its evidence', async () => {
      const orgs = Object.fromEntries((await q('SELECT * FROM filer_orgs')).map((o) => [o.org_key, o]));
      const [acme] = await q("SELECT id FROM contractors WHERE normalized_name = 'acme builders'");
      assert.deepStrictEqual([orgs['acme builders'].role, orgs['acme builders'].linked_bps, orgs['acme builders'].self_bps, String(orgs['acme builders'].contractor_id)],
        ['builder', 2, 2, String(acme.id)]);
      assert.match(orgs['acme builders'].basis, /pulled 2 of the 2/);
      assert.strictEqual(orgs['acme builders'].display_name, 'Acme Builders LLC');
      assert.deepStrictEqual([orgs['aqua permits'].role, orgs['aqua permits'].linked_bps], ['expediter', 1]);
      assert.strictEqual(orgs['other homes'].role, 'builder');
      assert.match(orgs['other homes'].basis, /same name as the contractor/);
      assert.deepStrictEqual([orgs['big apartments development'].role, orgs['big apartments development'].basis], ['unknown', 'no building permit linked yet']);
      assert.strictEqual(orgs['jane roe'].party_kind, 'individual');
      assert.strictEqual(first.orgsByRole.builder, 2);
    });

    await check('a re-run gives the same result', async () => {
      const again = await runFilers();
      assert.deepStrictEqual(again, first);
      assert.strictEqual((await q('SELECT count(*)::int AS n FROM filing_filers'))[0].n, 6);
      const runs = await q("SELECT status FROM resolver_runs WHERE resolver_version = 'filers-v1' ORDER BY id");
      assert.deepStrictEqual(runs.map((r) => r.status), ['succeeded', 'succeeded']);
    });

    await check('the homes list shows the builder and its past subs, never a person', async () => {
      const e = await listEarly(parseFilters({ source: 'austin-tx' }), { days: 30, segment: 'homes' });
      assert.strictEqual(e.segment, 'homes');
      assert.deepStrictEqual(e.filings.map((r) => r.permit_number).sort(), ['2026-1 PR', '2026-2 PR', '2026-3 PR', '2026-4 PR', '2026-6 PR', '2026-8 PR']);
      assert.deepStrictEqual(e.segmentCounts, { homes: 6, apartments: 1, commercial: 0 });
      const one = e.filings.find((r) => r.permit_number === '2026-1 PR');
      assert.deepStrictEqual([one.filer.name, one.filer.role, one.filer.filings], ['Acme Builders LLC', 'builder', 2]);
      assert.ok(one.filer.rawRecordId, 'provenance');
      const subs = one.builderSubs.map((s) => [s.trade, s.sub.name, s.jobs]);
      assert.deepStrictEqual(subs, [['electrical', 'Sparky Electric LLC', 2], ['plumbing', 'Pipe Plumbing Inc', 1]]);
      const two = e.filings.find((r) => r.permit_number === '2026-2 PR');
      assert.deepStrictEqual([two.filer.role, two.builderSubs], ['expediter', []]);
      const four = e.filings.find((r) => r.permit_number === '2026-4 PR');
      assert.deepStrictEqual([four.filer, four.filerWithheld], [null, true]);
      const three = e.filings.find((r) => r.permit_number === '2026-3 PR');
      assert.deepStrictEqual([three.filer, three.filerWithheld], [null, false], 'the owner org is not a filer');
      const json = JSON.stringify(e);
      for (const p of PEOPLE) assert.ok(!json.includes(p), `${p} reached the API`);
      assert.ok(!/applicant_|owner_/i.test(json), 'a raw person field reached the API');
    });

    await check('apartments are context, on their own; other markets are not segmented', async () => {
      const e = await listEarly(parseFilters({ source: 'austin-tx' }), { days: 30, segment: 'apartments' });
      assert.deepStrictEqual(e.filings.map((r) => [r.permit_number, r.segment, r.filer.role]), [['2026-5 PR', 'apartments', 'unknown']]);
      const all = await listEarly(parseFilters({ source: 'austin-tx' }), { days: 30 });
      assert.strictEqual(all.filings.length, 7);
      const raleigh = await listEarly(parseFilters({ source: 'raleigh-nc' }), { days: 30, segment: 'homes' });
      assert.deepStrictEqual([raleigh.segmentable, raleigh.segment, raleigh.segmentCounts], [false, null, null]);
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) { console.error(`\n${failures} failing`); process.exit(1); }
  console.log('\nall filers integration tests passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
