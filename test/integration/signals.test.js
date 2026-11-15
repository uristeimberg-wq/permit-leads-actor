// Integration: migration 036 (construction_signals, signal_links,
// entity_links, contractor_portfolio) and entity-matching accuracy through
// the real ingest and resolver, against a stubbed Miami-Dade layer.
//
// Entity checks (brief phase 4): identical licence numbers unify spellings of
// one firm; distinct firms with similar names stay apart; a name-only link is
// never counted as verified in a portfolio.
//
// Needs Postgres (DATABASE_URL; default localhost:5433). Creates and drops
// its own throwaway database.

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_signals_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const md = (num, name, licence, o = {}) => ({
  PermitNumber: `2026${String(num).padStart(6, '0')}`, PermitType: 'BLDG', ApplicationTypeDescription: 'NEW CONSTRUCTION',
  DetailDescriptionComments: 'New single family residence', EstimatedValue: 350000,
  PermitIssuedDate: Date.parse('2026-11-01T00:00:00Z'), PropertyAddress: `${num} NW 1 AVE`, City: 'MIAMI', State: 'FL',
  ContractorName: name, ContractorNumber: licence, ContractorPhone: '3055550100', ContractorCity: 'MIAMI',
  MasterPermitNumber: '0000000000', FolioNumber: `01310000${String(num).padStart(5, '0')}`, ...o,
});

let features = [];
global.fetch = async (url) => {
  const u = new URL(url);
  const offset = Number(u.searchParams.get('resultOffset') || 0);
  const n = Number(u.searchParams.get('resultRecordCount') || 500);
  const page = features.slice(offset, offset + n).map((attributes) => ({ attributes }));
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ features: page, exceededTransferLimit: false }) };
};

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const { resolveAll } = require('../../ingest/resolve.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  const one = async (sql, p) => (await q(sql, p))[0];
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };

  try {
    await db.applySchema();
    features = [
      md(1, 'NEXTEP ELECTRIC INC', 'EC13001234'),
      md(2, 'NEXTEP ELECTRIC, INC.', 'EC13001234'), // same licence, another spelling
      md(3, 'NEXTEP ELECTRICAL SERVICES LLC', 'EC13009999'), // similar name, different firm
      md(4, 'RADIANT PLUMBING & AC', 'CFC1427001'),
      md(5, 'RADIANT PLUMBING AND AIR CONDITIONING', 'CFC1427002'), // near-miss, another licence
      md(6, 'OWNER BUILDER', ''),
    ];
    await ingestArea('miami-dade-fl', { days: 14, allDetails: false });
    await resolveAll();

    await check('identical licence numbers unify two spellings of one firm', async () => {
      const r = await q(`SELECT DISTINCT pp.contractor_id FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id
                          WHERE p.permit_number IN ('2026000001', '2026000002')`);
      assert.strictEqual(r.length, 1);
      const c = await one('SELECT identity_key FROM contractors WHERE id = $1', [r[0].contractor_id]);
      assert.strictEqual(c.identity_key, 'lic:FL:EC13001234');
    });

    await check('distinct firms with similar names are not merged', async () => {
      const ids = await q(`SELECT p.permit_number, pp.contractor_id FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id
                            WHERE p.permit_number IN ('2026000001', '2026000003', '2026000004', '2026000005') ORDER BY 1`);
      assert.strictEqual(new Set(ids.map((r) => String(r.contractor_id))).size, 4);
    });

    await check('the owner-builder is no business entity', async () => {
      const r = await one(`SELECT pp.match_rule, pp.contractor_id FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id WHERE p.permit_number = '2026000006'`);
      assert.strictEqual(r.match_rule, 'owner_builder');
      assert.strictEqual(r.contractor_id, null);
    });

    await check('every entity link carries a provenance class; licence links are the verified ones', async () => {
      const r = await q(`SELECT match_rule, provenance, count(*)::int AS n FROM entity_links WHERE link_type = 'permit_contractor' GROUP BY 1, 2 ORDER BY 1`);
      assert.deepStrictEqual(r.map((x) => [x.match_rule, x.provenance, x.n]), [
        ['licence', 'cross_source_verified', 5], ['owner_builder', 'parsed_inferred', 1],
      ]);
      assert.strictEqual((await one(`SELECT count(*)::int AS n FROM entity_links WHERE provenance IS NULL`)).n, 0);
    });

    await check('a portfolio counts licence-linked and name-linked permits apart', async () => {
      const p = await one(`SELECT permits_licence_linked, permits_name_linked, markets FROM contractor_portfolio WHERE identity_key = 'lic:FL:EC13001234'`);
      assert.deepStrictEqual(p, { permits_licence_linked: 2, permits_name_linked: 0, markets: 1 });
      // A name-keyed firm (no licence on its permits) is never "verified".
      const c = await one(`INSERT INTO contractors (identity_key, display_name, normalized_name, party_kind, permit_count, resolver_version)
                           VALUES ('name:FL:acme roofing', 'ACME ROOFING', 'acme roofing', 'business', 1, 'test') RETURNING id`);
      await db.query(`UPDATE permit_parties SET contractor_id = $1, match_rule = 'name_state', match_confidence = 0.80
                       WHERE permit_id = (SELECT id FROM permits WHERE permit_number = '2026000004')`, [c.id]);
      const n = await one('SELECT permits_licence_linked, permits_name_linked FROM contractor_portfolio WHERE contractor_id = $1', [c.id]);
      assert.deepStrictEqual(n, { permits_licence_linked: 0, permits_name_linked: 1 });
      assert.strictEqual((await one(`SELECT provenance FROM entity_links WHERE link_type = 'permit_contractor' AND to_id = $1`, [c.id])).provenance, 'parsed_inferred');
    });

    // Signals: an application, a planning case and an inspection, each
    // linked to the issued permit 2026000001.
    const permitId = (await one(`SELECT id FROM permits WHERE permit_number = '2026000001'`)).id;
    const app = await one(`INSERT INTO permits (source_area, permit_number, address, filing_kind, lifecycle_stage, status_raw, submitted_on, trade_scores)
                           VALUES ('austin-plan-review-tx', 'PR-1', '1 NW 1 AVE', 'building_application', 'in_review', 'In Review', '2026-09-01', '{}') RETURNING id`);
    await db.query(`INSERT INTO permit_links (from_permit_id, to_permit_id, link_basis, basis_detail, confidence)
                    VALUES ($1, $2, 'official_reference', 'masterpermitnum = folderrsn', 1.00)`, [app.id, permitId]);
    const pc = await one(`INSERT INTO planning_cases (source_area, case_number, case_kind, status_raw, lifecycle_stage, filed_on, parcel_id, content_hash)
                          VALUES ('miami-derm-sewer-fl', 'D-1', 'utility_allocation', 'Approved', 'approved', '2026-07-01', '0131000000001', 'h') RETURNING id`);
    const pc2 = await one(`INSERT INTO planning_cases (source_area, case_number, case_kind, status_raw, lifecycle_stage, filed_on, content_hash)
                           VALUES ('austin-site-plans-tx', 'SP-1', 'site_plan', 'In Review', 'in_review', '2026-06-01', 'h') RETURNING id`);
    await db.query(`INSERT INTO planning_case_links (case_id, permit_id, link_basis, basis_detail, confidence) VALUES
                    ($1, $3, 'official_reference', 'ProcessNumber = permit number', 1.00),
                    ($2, $3, 'parcel_window', 'same property, filed within 2 years', 0.60)`, [pc.id, pc2.id, permitId]);
    await db.query(`INSERT INTO inspections (source_area, inspection_key, permit_number, permit_id, result_raw, result_class, scheduled_on, content_hash)
                    VALUES ('miami-dade-inspections-fl', 'I-1', '2026000001', $1, 'PASSED', 'approved', '2026-11-10', 'h')`, [permitId]);

    await check('construction_signals holds every kind of signal with its stage, phase and parcel provenance', async () => {
      const r = await q(`SELECT signal_type, lifecycle_phase, parcel_ref_provenance FROM construction_signals
                          WHERE signal_id IN ('permit:' || $1, 'permit:' || $2, 'planning_case:' || $3, 'planning_case:' || $4)
                             OR signal_type = 'inspection' ORDER BY signal_type`, [permitId, app.id, pc.id, pc2.id]);
      assert.deepStrictEqual(r.map((x) => [x.signal_type, x.lifecycle_phase, x.parcel_ref_provenance]), [
        ['building_application', 'plan_review', 'missing'],
        ['inspection', 'inspection', 'missing'],
        // Miami-Dade publishes the folio only in the raw row; without the
        // parcel enrichment run here, the permit has no parcel: missing.
        ['permit', 'issued', 'missing'],
        ['site_plan', 'plan_review', 'missing'],
        ['utility_allocation', 'approved', 'verified_source'],
      ]);
      // Once the folio is linked, the permit's parcel is a cross-source fact.
      const parcel = await one(`INSERT INTO parcels (provider, parcel_key, found, payload, sync_run_id)
                                  VALUES ('miami-dade-pa', '0131000000001', true, '{}', (SELECT min(id) FROM sync_runs)) RETURNING id`);
      await db.query(`INSERT INTO permit_parcels (permit_id, provider, parcel_id, match_rule) VALUES ($1, 'miami-dade-pa', $2, 'folio')`, [permitId, parcel.id]);
      const linked = await one(`SELECT parcel_ref, parcel_ref_provenance, parcel_id_provenance FROM construction_signals WHERE signal_id = 'permit:' || $1`, [permitId]);
      assert.deepStrictEqual(linked, { parcel_ref: '0131000000001', parcel_ref_provenance: 'cross_source_verified', parcel_id_provenance: 'cross_source_verified' });
      const total = await one(`SELECT (SELECT count(*) FROM permits)::int + (SELECT count(*) FROM planning_cases)::int + (SELECT count(*) FROM inspections)::int AS t,
                                      (SELECT count(*) FROM construction_signals)::int AS s`);
      assert.strictEqual(total.s, total.t);
    });

    await check('signal_links connect pre-permit filings to the permit, official keys verified and parcel windows inferred', async () => {
      const r = await q(`SELECT split_part(from_signal, ':', 1) AS kind, link_basis, provenance FROM signal_links WHERE to_signal = 'permit:' || $1 ORDER BY 1, 2`, [permitId]);
      assert.deepStrictEqual(r.map((x) => [x.kind, x.link_basis, x.provenance]), [
        ['inspection', 'official_reference', 'cross_source_verified'],
        ['permit', 'official_reference', 'cross_source_verified'],
        ['planning_case', 'official_reference', 'cross_source_verified'],
        ['planning_case', 'parcel_window', 'parsed_inferred'],
      ]);
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nDone.');
}

main().catch((err) => { console.error(err); process.exit(1); });
