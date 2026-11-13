// Integration: licence verification through real ingest + resolve runs, then
// enrich_licences against stubbed DBPR files and a stubbed TDLR API.
// Needs Postgres (DATABASE_URL; default :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_l_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const miami = require('../fixtures/sources/miami-dade-fl.json').rows.slice(0, 6).map((r) => ({ ...r, PermitIssuedDate: Date.now() - 86400000 }));
const today = new Date().toISOString().slice(0, 10);
const austin = [1, 2, 3].map((n) => ({
  permit_number: `2026-${n} EP`, permittype: 'EP', permit_type_desc: 'Electrical Permit', status_current: 'Active',
  issue_date: `${today}T00:00:00.000`, original_address1: `${n} MAIN ST`, original_city: 'AUSTIN', original_state: 'TX',
  contractor_company_name: 'Sparky Electric LLC', contractor_phone: '5125550142',
}));
// A City of Miami permit by the same firm as the county's CGC1539958 holder:
// no phone column, and no licence number, only the company name.
const city = [{ PermitNumber: 'BD26000001001B001', ApplicationNumber: 'BD26000001', IssuedDate: Date.now() - 86400000,
  CompanyName: 'MADS CONSTRUCTION INC', ScopeofWork: 'NEW CONSTRUCTION', DeliveryAddress: '1 NW 1 ST', BuildingPermitStatusDescription: 'Active' }];
let mode = 'miami';
global.fetch = async () => ({ ok: true, status: 200, json: async () => (mode === 'austin' ? austin
  : { features: (mode === 'city' ? city : miami).map((attributes) => ({ attributes })) }), text: async () => '' });

// DBPR: the county's CGC1539958 is written with a leading zero; one row is noise.
const dbpr = [
  '"06","CGC","DOE, JANE","MADS CONSTRUCTION INC","01","1 MAIN ST","","","MIAMI","FL","33101","23","1539958","C","A","01/02/2010","09/01/2024","08/31/2026","","2","CGC01539958",""',
  '"06","CBC","ROE, JOHN","UNRELATED BUILDERS LLC","01","2 MAIN ST","","","TAMPA","FL","33601","29","9999999","C","","01/02/2010","09/01/2024","08/31/2026","","2","CBC9999999",""',
].join('\r\n');
const licenceFetch = async (url) => {
  if (url.includes('myfloridalicense')) return { ok: true, status: 200, headers: new Map([['last-modified', 'Fri, 13 Nov 2026 06:00:00 GMT']]), text: async () => (url.includes('lic08el') ? '' : dbpr) };
  if (url.includes('/api/views/')) return { ok: true, status: 200, json: async () => ({ rowsUpdatedAt: 1792368000 }) };
  assert.ok(!/owner|mailing/.test(decodeURIComponent(url)), 'TDLR owner or mailing columns must not be requested');
  return { ok: true, status: 200, json: async () => [
    { license_type: 'Electrical Contractor', license_number: '31234', business_name: 'SPARKY ELECTRIC LLC', business_telephone: '(512) 555-0142', license_expiration_date_mmddccyy: '05/31/2027' },
    { license_type: 'A/C Contractor', license_number: 'TACLB9', business_name: 'NOBODY WE KNOW LLC' },
  ] };
};

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  let db;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  try {
    db = require('../../db/index.js');
    const { ingestArea } = require('../../ingest/run.js');
    const { resolveAll } = require('../../ingest/resolve.js');
    const { enrichLicences } = require('../../ingest/enrich_licences.js');
    const q = async (sql, p) => (await db.query(sql, p)).rows;
    await db.applySchema();
    await ingestArea('miami-dade-fl', { days: 14, max: 100, allDetails: false });
    mode = 'city';
    await ingestArea('miami-city-fl', { days: 14, max: 100, allDetails: false });
    mode = 'austin';
    await ingestArea('austin-tx', { days: 14, max: 100, allDetails: false });
    await resolveAll();

    await check('Florida: the permit licence number finds its DBPR row despite the leading zero; unrelated rows are not stored', async () => {
      const s = await enrichLicences('fl-dbpr', { fetchImpl: licenceFetch });
      // The county holder links by licence number, the City of Miami firm by its unique name.
      assert.deepStrictEqual([s.rows, s.kept, s.byRule], [2, 1, { licence: 1, name_state: 1 }]);
      const [l] = await q("SELECT l.licence_number, l.primary_status, l.expires_on::text, c.identity_key FROM contractor_registry_licences cl JOIN registry_licences l ON l.id = cl.licence_id JOIN contractors c ON c.id = cl.contractor_id WHERE cl.provider = 'fl-dbpr'");
      assert.deepStrictEqual([l.licence_number, l.primary_status, l.expires_on, l.identity_key], ['CGC01539958', 'C', '2026-08-31', 'lic:FL:CGC1539958']);
    });

    await check('Texas: the shown permit phone matches the TDLR electrical licence; owner columns never requested', async () => {
      const s = await enrichLicences('tx-tdlr', { fetchImpl: licenceFetch });
      assert.deepStrictEqual([s.kept, s.byRule], [1, { phone: 1 }]);
      const [l] = await q("SELECT l.phone, l.licence_type, l.file_date IS NOT NULL AS dated FROM registry_licences l WHERE provider = 'tx-tdlr'");
      assert.deepStrictEqual([l.phone, l.licence_type, l.dated], ['+15125550142', 'Electrical Contractor', true]);
    });

    await check('the contractor API shows the registry record with its match and credit, never the holder name', async () => {
      const { getContractor } = require('../../db/pilot_queries.js');
      const [{ id }] = await q("SELECT id FROM contractors WHERE identity_key = 'lic:FL:CGC1539958'");
      const { registry } = await getContractor(id);
      assert.deepStrictEqual([registry.length, registry[0].number, registry[0].matchedBy, registry[0].status.primary], [1, 'CGC01539958', 'licence', 'C']);
      assert.ok(registry[0].provenance.attribution.includes('Florida'));
      assert.ok(!JSON.stringify(registry).includes('DOE'));
    });

    await check('a City of Miami firm gets the county licence holder\'s phone, labelled as reached through the licence', async () => {
      const { getContractor } = require('../../db/pilot_queries.js');
      const [{ id: cityId }] = await q("SELECT c.id FROM contractors c JOIN permit_parties pp ON pp.contractor_id = c.id JOIN permits p ON p.id = pp.permit_id WHERE p.source_area = 'miami-city-fl'");
      const [{ id: countyId, phone }] = await q("SELECT c.id, cp.value AS phone FROM contractors c JOIN contact_points cp ON cp.contractor_id = c.id WHERE c.identity_key = 'lic:FL:CGC1539958'");
      const { contractor } = await getContractor(cityId);
      assert.deepStrictEqual([contractor.phone.value, contractor.phone.verification, contractor.phone.viaLicence.number, Number(contractor.phone.viaLicence.contractorId)],
        [phone, 'via_licence', 'CGC01539958', Number(countyId)]);
      // The county holder keeps its own phone, not a borrowed one.
      assert.notStrictEqual((await getContractor(countyId)).contractor.phone.verification, 'via_licence');
    });

    await check('a re-run replaces links instead of duplicating them', async () => {
      await enrichLicences('tx-tdlr', { fetchImpl: licenceFetch });
      const [{ n }] = await q("SELECT count(*)::int AS n FROM contractor_registry_licences WHERE provider = 'tx-tdlr'");
      assert.strictEqual(n, 1);
    });

    await check('a failing provider is recorded with its error class', async () => {
      await assert.rejects(enrichLicences('fl-dbpr', { fetchImpl: async () => ({ ok: false, status: 403, headers: new Map() }) }));
      const [r] = await q("SELECT r.status, r.error_class FROM sync_runs r JOIN sources s ON s.id = r.source_id WHERE s.slug = 'fl-dbpr' ORDER BY r.id DESC LIMIT 1");
      assert.deepStrictEqual([r.status, r.error_class], ['failed', 'auth']);
    });
  } finally {
    if (db) await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
