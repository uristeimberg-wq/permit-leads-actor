// Integration: inspections through real ingests (ingest/run.js) against
// stubbed ArcGIS answers: rows upsert without duplicates (the Miami-Dade
// layer repeats rows), a result change writes one history row, permit links
// need the number and the house number, and an inspection source never
// writes permits. Needs Postgres (DATABASE_URL; :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_insp_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const md = require('../fixtures/sources/miami-dade-inspections-fl.json').rows;
const ral = require('../fixtures/sources/raleigh-inspections-nc.json').rows;
let mdRows = [...md, md[0], md[1]]; // the live layer repeats rows
let ralRows = ral;
const urls = [];
global.fetch = async (url) => {
  const u = String(url);
  urls.push(u);
  const first = u.includes('resultOffset=0');
  const rows = u.includes('inspectionsData') ? mdRows : u.includes('Inspection_Schedule_Public') ? ralRows : [];
  return { ok: true, status: 200, json: async () => ({ features: first ? rows.map((attributes) => ({ attributes })) : [] }), text: async () => '' };
};

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const { linkPermits, report } = require('../../ingest/inspections.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  const run = (area) => ingestArea(area, { days: 30, max: 1000, allDetails: false });
  try {
    await db.applySchema();

    await check('the migration registers both sources as enabled inspection sources', async () => {
      const rows = await q("SELECT slug, enabled, role FROM sources WHERE role = 'inspections' ORDER BY slug");
      assert.deepStrictEqual(rows.map((r) => [r.slug, r.enabled]), [['miami-dade-inspections-fl', true], ['raleigh-inspections-nc', true]]);
    });

    await run('miami-dade-inspections-fl');
    await run('raleigh-inspections-nc');

    await check('only the listed columns are requested, and Raleigh code-enforcement rows are filtered at the source', async () => {
      const m = urls.find((u) => u.includes('inspectionsData'));
      assert.ok(!m.includes('outFields=*') && /outFields=ObjectId%2Cpermit_number/.test(m), m);
      const r = urls.find((u) => u.includes('Inspection_Schedule_Public'));
      assert.ok(decodeURIComponent(r.replace(/\+/g, ' ')).includes("InspectionType NOT LIKE 'HS -%'"), r);
    });

    await check('one inspection per key, repeated rows collapse, nothing written to permits', async () => {
      const n = await q("SELECT source_area, count(*)::int AS n, count(DISTINCT inspection_key)::int AS k FROM inspections GROUP BY 1 ORDER BY 1");
      const mdKeys = new Set(md.map((r) => [r.permit_number, r.sequence_number, r.request_date, r.input_order, r.inspector_id].join('|'))).size;
      assert.deepStrictEqual(n.map((r) => [r.source_area, r.n, r.k]), [['miami-dade-inspections-fl', mdKeys, mdKeys], ['raleigh-inspections-nc', ral.length, ral.length]]);
      assert.strictEqual((await q('SELECT count(*)::int AS n FROM permits'))[0].n, 0);
      assert.strictEqual((await q("SELECT count(*)::int AS n FROM inspections WHERE latest_raw_record_id IS NULL"))[0].n, 0, 'every inspection points at its raw record');
    });

    await check('a re-run with nothing changed writes no history', async () => {
      const before = (await q('SELECT count(*)::int AS n FROM inspection_result_history'))[0].n;
      await run('raleigh-inspections-nc');
      assert.strictEqual((await q('SELECT count(*)::int AS n FROM inspection_result_history'))[0].n, before);
    });

    await check('a result change keeps the old result in history', async () => {
      const target = ral[0].IMInspectionID;
      ralRows = ral.map((r) => (r.IMInspectionID === target ? { ...r, InspectionStatus: 'Re-inspection Required', IsCompleted: 'True' } : r));
      await run('raleigh-inspections-nc');
      const h = await q(`SELECT h.result_raw, h.result_class FROM inspection_result_history h JOIN inspections i ON i.id = h.inspection_id
                          WHERE i.inspection_key = $1 ORDER BY h.id`, [target]);
      assert.strictEqual(h.length, 2);
      assert.deepStrictEqual(h[1], { result_raw: 'Re-inspection Required', result_class: 'rejected' });
      assert.strictEqual(h[0].result_raw, ral[0].InspectionStatus);
    });

    await check('a permit link needs the same number and the same house number', async () => {
      const a = ral[0];
      const b = ral.find((x) => x.LinkNumber !== a.LinkNumber);
      const house = (x) => String(x.Address).split(' ')[0];
      await q("INSERT INTO permits (source_area, permit_number, address) VALUES ('raleigh-nc', $1, $2)", [a.LinkNumber, `${house(a)} Somewhere St`]);
      await q("INSERT INTO permits (source_area, permit_number, address) VALUES ('raleigh-nc', $1, $2)", [b.LinkNumber, '99999 Other Rd']);
      await db.withTransaction(linkPermits);
      const rows = await q('SELECT inspection_key, permit_id FROM inspections WHERE inspection_key = ANY($1)', [[a.IMInspectionID, b.IMInspectionID]]);
      const by = Object.fromEntries(rows.map((r) => [r.inspection_key, r.permit_id]));
      assert.ok(by[a.IMInspectionID], 'same number and house number links');
      assert.strictEqual(by[b.IMInspectionID], null, 'same number, other house: not linked');
      // The address is corrected at the source: the link is cleared.
      await q("UPDATE permits SET address = '1 Elsewhere' WHERE permit_number = $1", [a.LinkNumber]);
      await db.withTransaction(linkPermits);
      assert.strictEqual((await q('SELECT permit_id FROM inspections WHERE inspection_key = $1', [a.IMInspectionID]))[0].permit_id, null);
    });

    await check('the report counts classes and lists unmapped wordings', async () => {
      const r = await report();
      assert.ok(r.classes.length > 0);
      assert.ok(r.links.every((l) => l.inspections > 0));
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
