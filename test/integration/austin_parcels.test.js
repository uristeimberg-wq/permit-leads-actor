// Integration: Austin parcel points (coverage plan item 4). A real Austin
// ingest, then the City of Austin parcel-geometry layer stubbed with the
// recorded fixture, then the locations run. Austin permits without source
// coordinates get the parcel centroid, credited to the City of Austin, and
// the point-only parcel never stands in for property facts. Needs Postgres
// (DATABASE_URL; default :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_ap_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const fx = require('../fixtures/enrichment/austin-parcels.json');
const known = fx.features.map((f) => f.attributes.PID_10);

const row = (num, tcad) => ({
  permit_number: `2026-${num} BP`, permittype: 'BP', permit_type_desc: 'BP Permit', description: 'Kitchen remodel',
  status_current: 'Active', issue_date: '2026-11-01T00:00:00.000', original_address1: `${num} MAIN ST`,
  original_city: 'AUSTIN', original_state: 'TX', original_zip: '78701', tcad_id: tcad,
  contractor_company_name: 'Acme Builders LLC', contractor_phone: '5125550100',
});
// Three on the fixture's parcels; one whose geo id the layer lacks; one with a
// property-id-form tcad_id the layer is not keyed by.
const austin = [row(1, known[0]), row(2, known[1]), row(3, known[2]), row(4, '0999999999'), row(5, 'R000222')];
global.fetch = async () => ({ ok: true, json: async () => austin, text: async () => '' });

const asked = [];
const layerFetch = async (url, init) => {
  const u = new URL(url);
  if (!u.pathname.endsWith('/query')) return { ok: true, status: 200, json: async () => ({ editingInfo: { lastEditDate: fx.lastEditDate } }) };
  const form = new URLSearchParams(init.body);
  const keys = [...form.get('where').matchAll(/'(\d+)'/g)].map((m) => m[1]);
  asked.push({ keys, outFields: form.get('outFields') });
  return { ok: true, status: 200, json: async () => ({ features: fx.features.filter((f) => keys.includes(f.attributes.PID_10)) }) };
};

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const { enrichParcels } = require('../../ingest/enrich_parcels.js');
  const { geocodePermits } = require('../../ingest/geocode.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  try {
    await db.applySchema();
    await ingestArea('austin-tx', { days: 14, max: 100, allDetails: false });

    await check('geo ids are asked once for the two fields; found ones link by tcad_geo_id; the property-id form is not asked', async () => {
      const s = await enrichParcels({ providerSlug: 'austin-parcels', fetchImpl: layerFetch });
      assert.strictEqual(asked.length, 1);
      assert.strictEqual(asked[0].outFields, 'PID_10,PROP_ID');
      assert.deepStrictEqual(asked[0].keys.sort(), [...known, '0999999999'].sort());
      assert.deepStrictEqual([s.distinctKeys, s.found, s.linked], [4, 3, 3]);
      const rules = await q("SELECT DISTINCT match_rule FROM permit_parcels WHERE provider = 'austin-parcels'");
      assert.deepStrictEqual(rules.map((r) => r.match_rule), ['tcad_geo_id']);
    });

    await check('each found parcel has a centroid inside its polygon and no property facts', async () => {
      for (const f of fx.features) {
        const [p] = await q("SELECT lat, lng, year_built, lot_sqft, land_value FROM parcels WHERE provider = 'austin-parcels' AND parcel_key = $1", [f.attributes.PID_10]);
        const xs = f.geometry.rings.flat().map((c) => c[0]);
        const ys = f.geometry.rings.flat().map((c) => c[1]);
        assert.ok(p.lng > Math.min(...xs) && p.lng < Math.max(...xs) && p.lat > Math.min(...ys) && p.lat < Math.max(...ys), f.attributes.PID_10);
        assert.deepStrictEqual([p.year_built, p.lot_sqft, p.land_value], [null, null, null]);
      }
    });

    await check('the locations run places the three permits from the parcel, credited to the City of Austin', async () => {
      // Only permits 4 and 5 still need the Census; it answers "no match".
      const sent = [];
      const csv = async (url, init) => {
        const text = await init.body.get('addressFile').text();
        const lines = text.trim().split('\n').map((l) => l.split('","').map((f) => f.replace(/"/g, '')));
        sent.push(...lines.map((l) => l[1]));
        return { ok: true, status: 200, text: async () => lines.map(([id, street]) => `"${id}","${street}","No_Match"`).join('\n') };
      };
      const s = await geocodePermits({ fetchImpl: csv });
      assert.strictEqual(s.byMethod.parcel, 3);
      assert.deepStrictEqual(sent.sort(), ['4 MAIN ST', '5 MAIN ST'], 'the Census is asked only for the permits no parcel placed');
      const [{ id }] = await q("SELECT id FROM permits WHERE permit_number = '2026-1 BP'");
      const { getJob, parseFilters } = require('../../db/pilot_queries.js');
      const job = await getJob(id, parseFilters({ trade: 'electrical', source: 'austin-tx' }));
      const loc = job.location;
      assert.strictEqual(loc.method, 'parcel');
      assert.strictEqual(loc.provenance.source, 'austin-parcels');
      assert.match(loc.provenance.attribution, /City of Austin/);
      assert.ok(!job.property || job.property.provenance.source !== 'austin-parcels', 'a point-only parcel is never the property panel');
    });

    await check('a second run asks for nothing and keeps one link per permit', async () => {
      const before = asked.length;
      const s = await enrichParcels({ providerSlug: 'austin-parcels', fetchImpl: layerFetch });
      assert.strictEqual(s.requested, 0);
      assert.strictEqual(asked.length, before);
      const [{ n, d }] = await q("SELECT count(*)::int AS n, count(DISTINCT permit_id)::int AS d FROM permit_parcels WHERE provider = 'austin-parcels'");
      assert.deepStrictEqual([n, d], [3, 3]);
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
