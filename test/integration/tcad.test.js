// Integration: Travis CAD property facts through a real Austin ingest and
// enrich runs against an in-memory export (no zip, no network). Needs
// Postgres (DATABASE_URL; default :5433).

const assert = require('node:assert');
const { Client } = require('pg');
const T = require('../../src/enrichment/tcad.js');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_t_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const row = (num, tcad) => ({
  permit_number: `2026-${num} BP`, permittype: 'BP', permit_type_desc: 'BP Permit', description: 'Kitchen remodel',
  status_current: 'Active', issue_date: '2026-11-01T00:00:00.000', original_address1: `${num} MAIN ST`,
  original_city: 'AUSTIN', original_state: 'TX', original_zip: '78701', tcad_id: tcad,
  contractor_company_name: 'Acme Builders LLC', contractor_phone: '5125550100',
});
const austin = [row(1, '0414181801'), row(2, 'R000222'), row(3, '0999999999'), row(4, '0555555555'), row(5, '0777777777')];
global.fetch = async () => ({ ok: true, json: async () => austin, text: async () => '' });

function line(length, fields) {
  const a = Array(length).fill(' ');
  for (const [[start, end], v] of fields) {
    const s = String(v).padEnd(end - start + 1).slice(0, end - start + 1);
    for (let i = 0; i < s.length; i += 1) a[start - 1 + i] = s[i];
  }
  return a.join('');
}
const P = T.PROP;
const prop = (id, geo, o = []) => line(9922, [[P.propId, id.padStart(12, '0')], [P.propType, 'R'], [P.rollYear, '2026'], [P.geoId, geo],
  [[609, 678], 'SECRET OWNER'], [P.situsCity, 'AUSTIN'], [P.situsZip, '78701'], [P.landHstd, '100000'], [P.imprvNonHstd, '250000'],
  [P.imprvStateCd, 'A1'], ...o]);
const imp = (id, imprv, desc, v) => line(114, [[T.IMP_INFO.propId, id.padStart(12, '0')], [T.IMP_INFO.imprvId, imprv], [T.IMP_INFO.typeDesc, desc], [T.IMP_INFO.value, String(v)]]);
const det = (id, imprv, code, yr, area) => line(622, [[T.IMP_DET.propId, id.padStart(12, '0')], [T.IMP_DET.imprvId, imprv], [T.IMP_DET.typeCd, code], [T.IMP_DET.yearBuilt, yr], [T.IMP_DET.area, String(area)]]);

const files = (props) => ({
  url: 'test://export.zip', fileDate: new Date('2026-11-10T15:30:00Z'),
  names: ['APPR_HDR.TXT', 'PROP.TXT', 'IMP_INFO.TXT', 'IMP_DET.TXT', 'PROP_ENT.TXT'],
  lines: (name) => ({
    'PROP.TXT': props,
    'IMP_INFO.TXT': [imp('111', '1', '1 FAM DWELLING', 250000), imp('222', '9', 'COMMERCIAL', 900000)],
    'IMP_DET.TXT': [det('111', '1', '1ST', '1998', 1500), det('111', '1', '2ND', '2004', 600), det('111', '1', '041', '1998', 400),
      det('222', '9', '1ST', '1985', 8000)],
  })[name] || [],
});
const baseProps = [
  prop('111', '0414181801'),
  prop('222', '0222000000'), // linked through the letter + digits form of tcad_id
  prop('333', '0999999999', [[[991, 991], 'T']]), // address suppressed: never stored
  prop('444', '0555555555'), prop('445', '0555555555'), // two real properties on one geo_id: ambiguous
  prop('900', '0123456789'), // no permit names it: not stored
];

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const { enrichTcad } = require('../../ingest/enrich_tcad.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  try {
    await db.applySchema();
    await ingestArea('austin-tx', { days: 14, max: 100, allDetails: false });

    await check('only parcels permits name are stored; confidential ones never; ambiguous geo_ids are not linked', async () => {
      const s = await enrichTcad({ files: files(baseProps), minPropRows: 1 });
      assert.deepStrictEqual([s.propRows, s.wanted, s.confidential, s.stored, s.linked, s.ambiguous], [6, 5, 1, 4, 2, 1]);
      const keys = (await q("SELECT parcel_key FROM parcels WHERE provider = 'travis-cad' ORDER BY 1")).map((r) => r.parcel_key);
      assert.deepStrictEqual(keys, ['111', '222', '444', '445']);
      const rules = await q(`SELECT p.permit_number, pp.match_rule FROM permit_parcels pp JOIN permits p ON p.id = pp.permit_id
        WHERE pp.provider = 'travis-cad' ORDER BY 1`);
      assert.deepStrictEqual(rules.map((r) => [r.permit_number, r.match_rule]), [['2026-1 BP', 'tcad_geo_id'], ['2026-2 BP', 'tcad_prop_id']]);
    });

    await check('stored facts: floors summed, earliest floor year, values summed; no owner anywhere', async () => {
      const [p] = await q("SELECT * FROM parcels WHERE provider = 'travis-cad' AND parcel_key = '111'");
      assert.deepStrictEqual([p.year_built, Number(p.heated_sqft), Number(p.land_value), Number(p.improvement_value), p.improvement_type, p.land_use_code, p.assessment_year],
        [1998, 2100, 100000, 250000, '1 FAM DWELLING', 'A1', 2026]);
      const all = JSON.stringify(await q("SELECT * FROM parcels WHERE provider = 'travis-cad'"));
      assert.ok(!/SECRET OWNER/.test(all));
    });

    await check('the job API labels values as appraisal estimates with the roll year and credits TCAD', async () => {
      const { getJob, parseFilters } = require('../../db/pilot_queries.js');
      const [{ id }] = await q("SELECT id FROM permits WHERE permit_number = '2026-1 BP'");
      const job = await getJob(id, parseFilters({ trade: 'electrical', source: 'austin-tx' }));
      assert.deepStrictEqual([job.property.yearBuilt, job.property.heatedSqft, job.property.valueNote, job.property.provenance.source],
        [1998, 2100, 'Appraisal estimate, 2026 roll', 'travis-cad']);
      assert.match(job.property.provenance.attribution, /Travis Central Appraisal District/);
    });

    await check('a parcel that turns confidential is deleted with its link on the next run', async () => {
      const next = baseProps.map((l, i) => (i === 0 ? prop('111', '0414181801', [[[4859, 4859], 'T']]) : l));
      const s = await enrichTcad({ files: files(next), minPropRows: 1 });
      assert.deepStrictEqual([s.stored, s.removed, s.linked], [3, 1, 1]);
      const [{ n }] = await q("SELECT count(*)::int AS n FROM parcels WHERE provider = 'travis-cad' AND parcel_key = '111'");
      assert.strictEqual(n, 0);
    });

    await check('a truncated export is a schema failure, recorded with its class, and changes nothing', async () => {
      await assert.rejects(enrichTcad({ files: files(baseProps.slice(0, 2)) }), /schema/);
      const runs = await q("SELECT r.status, r.error_class FROM sync_runs r JOIN sources s ON s.id = r.source_id WHERE s.slug = 'travis-cad' ORDER BY r.id");
      assert.deepStrictEqual(runs.map((r) => [r.status, r.error_class]), [['succeeded', null], ['succeeded', null], ['failed', 'schema']]);
      const [{ n }] = await q("SELECT count(*)::int AS n FROM parcels WHERE provider = 'travis-cad'");
      assert.strictEqual(n, 3);
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.end();
  }
  if (failures) process.exitCode = 1;
}

// exit, not exitCode: a failure before the try (a module that won't load)
// would otherwise leave the admin client open and hang CI.
main().catch((err) => { console.error(err); process.exit(1); });
