// Integration: Wake County parcels for Raleigh permits (ADR-23 sprint 1),
// through a real Raleigh ingest and enrich run against stubbed ArcGIS
// endpoints. The parcel stub serves the recorded fixture for three pins and
// nothing for the rest. Needs Postgres (DATABASE_URL; default :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_w_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const wake = require('../fixtures/enrichment/wake-parcels.json');
const fixture = require('../fixtures/sources/raleigh-nc.json');
const known = wake.features.map((f) => f.attributes.PIN_NUM);
// Six building permits: three on the fixture's parcels, three on pins Wake does not have.
const rows = fixture.rows.filter((r) => 'latitude_perm' in r).slice(0, 6)
  .map((r, i) => ({ ...r, issueddate: Date.now() - 86400000, pin: i < 3 ? known[i] : r.pin }));
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ features: rows.map((attributes) => ({ attributes })) }) });

const asked = [];
const wakeFetch = async (url, init) => {
  const u = new URL(url);
  if (!u.pathname.endsWith('/query')) return { ok: true, status: 200, json: async () => ({}) };
  const form = new URLSearchParams(init.body);
  const keys = [...form.get('where').matchAll(/'(\d+)'/g)].map((m) => m[1]);
  asked.push({ keys, outFields: form.get('outFields') });
  return { ok: true, status: 200, json: async () => ({ features: wake.features.filter((f) => keys.includes(f.attributes.PIN_NUM)) }) };
};

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const { enrichParcels } = require('../../ingest/enrich_parcels.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  try {
    await db.applySchema();
    await ingestArea('raleigh-nc', { days: 14, max: 100, allDetails: false });
    const pins = [...new Set(rows.map((r) => r.pin))];

    await check('Raleigh pins are asked once, with no owner or sale field, and the found ones link', async () => {
      const s = await enrichParcels({ providerSlug: 'wake-parcels', fetchImpl: wakeFetch });
      assert.strictEqual(asked.length, 1);
      assert.ok(!/owner|addr|deed_(book|page|date)|sale|exempt|bill/i.test(asked[0].outFields));
      assert.deepStrictEqual([s.distinctKeys, s.found], [pins.length, 3]);
      const links = await q("SELECT match_rule, raw_record_id FROM permit_parcels WHERE provider = 'wake-parcels'");
      assert.strictEqual(links.length, rows.filter((r) => known.includes(r.pin)).length);
      assert.ok(links.every((l) => l.match_rule === 'pin' && l.raw_record_id));
    });

    await check('the apartment parcel carries its facts, values and a centroid; a missing pin stays empty', async () => {
      const [p] = await q("SELECT year_built, heated_sqft::int, units::int, land_value::int, improvement_value::int, lat, lng FROM parcels WHERE provider = 'wake-parcels' AND parcel_key = '1703290757'");
      assert.deepStrictEqual([p.year_built, p.heated_sqft, p.units, p.land_value, p.improvement_value], [2013, 126760, 115, 8448900, 18716037]);
      assert.ok(Math.abs(p.lat - 35.782) < 0.001 && Math.abs(p.lng + 78.656) < 0.001);
      const missing = await q("SELECT found, year_built FROM parcels WHERE provider = 'wake-parcels' AND NOT found");
      assert.ok(missing.length >= 1 && missing.every((m) => m.year_built == null));
    });

    await check('a second run asks for nothing (fresh parcels) and keeps one link per permit', async () => {
      const before = asked.length;
      const s = await enrichParcels({ providerSlug: 'wake-parcels', fetchImpl: wakeFetch });
      assert.strictEqual(s.requested, 0);
      assert.strictEqual(asked.length, before);
      const [{ n, d }] = await q("SELECT count(*)::int AS n, count(DISTINCT permit_id)::int AS d FROM permit_parcels WHERE provider = 'wake-parcels'");
      assert.strictEqual(n, d);
    });

    await check('the run is recorded against the wake-parcels source', async () => {
      const runs = await q("SELECT r.status FROM sync_runs r JOIN sources s ON s.id = r.source_id WHERE s.slug = 'wake-parcels'");
      assert.ok(runs.length === 2 && runs.every((r) => r.status === 'succeeded'));
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
