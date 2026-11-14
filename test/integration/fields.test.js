// Integration: field observations and conflicts (ADR-23, migration 023) over
// a real Raleigh ingest, Wake parcels enrich and building-facts run, all on
// stubbed endpoints. Needs Postgres (DATABASE_URL; default :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_fo_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const wake = require('../fixtures/enrichment/wake-parcels.json');
const fixture = require('../fixtures/sources/raleigh-nc.json');
// Four building permits: two on the apartment parcel (115 units on the roll)
// that say 115 and 120 units, one on the church parcel saying 3 floors, one on
// a pin Wake does not have.
const base = fixture.rows.filter((r) => 'latitude_perm' in r).slice(0, 4);
const rows = [
  { ...base[0], pin: '1703290757', housingunitstotal: 115, numberstories: null },
  { ...base[1], pin: '1703290757', housingunitstotal: 120, numberstories: null },
  { ...base[2], pin: '1703734710', housingunitstotal: null, numberstories: 3 },
  { ...base[3], pin: '9999999999', housingunitstotal: 2, numberstories: 2 },
].map((r) => ({ ...r, issueddate: Date.now() - 86400000 }));
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ features: rows.map((attributes) => ({ attributes })) }) });

const wakeFetch = async (url, init) => {
  const u = new URL(url);
  if (!u.pathname.endsWith('/query')) return { ok: true, status: 200, json: async () => ({}) };
  const form = new URLSearchParams(init.body);
  const keys = [...form.get('where').matchAll(/'(\d+)'/g)].map((m) => m[1]);
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
  const { runFacts } = require('../../ingest/facts.js');
  const { runFields } = require('../../ingest/fields.js');
  const { resolveAll } = require('../../ingest/resolve.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  const conflict = async (pin, field) => (await q(`
    SELECT fc.status, fc.resolution, cardinality(fc.observation_ids) AS n FROM field_conflicts fc
      JOIN properties pr ON pr.id = fc.entity_id WHERE pr.parcel_key = $1 AND fc.field = $2`, [pin, field]))[0];
  try {
    await db.applySchema();
    await ingestArea('raleigh-nc', { days: 14, max: 100, allDetails: false });
    await enrichParcels({ providerSlug: 'wake-parcels', fetchImpl: wakeFetch });
    await runFacts();
    await resolveAll();  // marks building permits (permit_parties.is_building), as the sync does before this step
    let first;

    await check('one property per found parcel; parcel and permit observations with their tiers', async () => {
      first = await runFields();
      const [{ n }] = await q("SELECT count(*)::int AS n FROM properties WHERE county = 'wake-county-nc'");
      assert.strictEqual(n, 2, "the two fixture parcels the permits are on");
      const obs = await q(`SELECT o.field, o.value, o.confidence, o.method, s.slug, o.raw_record_id FROM field_observations o
                             JOIN sources s ON s.id = o.source_id JOIN properties pr ON pr.id = o.entity_id
                            WHERE pr.parcel_key = '1703290757' AND o.field = 'units' ORDER BY o.value::text`);
      assert.deepStrictEqual(obs.map((o) => [o.value, o.confidence, o.slug]),
        [[115, 'high', 'wake-parcels'], [115, 'medium', 'raleigh-nc'], [120, 'medium', 'raleigh-nc']]);
      assert.ok(obs.filter((o) => o.slug === 'raleigh-nc').every((o) => o.raw_record_id), 'permit observations trace to raw');
      const unlinked = await q("SELECT 1 FROM field_observations o JOIN properties pr ON pr.id = o.entity_id WHERE pr.parcel_key = '9999999999'");
      assert.strictEqual(unlinked.length, 0, 'nothing for a pin the county does not have');
    });

    await check('disagreements are explicit: the roll wins, the permit value stays visible', async () => {
      const u = await conflict('1703290757', 'units');
      assert.strictEqual(u.status, 'auto_resolved');
      assert.ok(/wake-parcels 1703290757 says 115/.test(u.resolution) && /says 120/.test(u.resolution));
      assert.strictEqual(u.n, 3);
      // Wake publishes no floors, so a permit's 3 floors stands alone: no conflict.
      assert.strictEqual(await conflict('1703734710', 'floors'), undefined);
    });

    await check('a trade permit never speaks for the property (fields-v2)', async () => {
      // Turn the 120-unit permit into a trade permit: its observation stops counting, so the conflict is gone.
      await q(`UPDATE permit_parties SET is_building = false
                WHERE permit_id IN (SELECT f.permit_id FROM permit_facts f WHERE f.units = 120)`);
      await runFields();
      const c = await conflict('1703290757', 'units');
      assert.strictEqual(c, undefined, 'without the trade permit, roll and building permit agree on 115: no conflict');
      await q(`UPDATE permit_parties SET is_building = true
                WHERE permit_id IN (SELECT f.permit_id FROM permit_facts f WHERE f.units = 120)`);
      await runFields();
    });

    await check('a re-run writes nothing and duplicates nothing', async () => {
      const again = await runFields();
      assert.deepStrictEqual([again.properties, again.parcels.written, again.permits.written], [0, 0, 0]);
      const [{ n, d }] = await q(`SELECT count(*)::int AS n, count(DISTINCT (entity_id, field, source_id, source_ref, value_hash))::int AS d
                                    FROM field_observations`);
      assert.strictEqual(n, d);
      assert.ok(first.parcels.written > 0);
    });

    await check('a changed roll value is a new observation, the old one kept; going back makes it current again', async () => {
      await q("UPDATE parcels SET units = 120, fetched_at = now() WHERE parcel_key = '1703290757'");
      await runFields();
      const vals = await q(`SELECT o.value FROM field_observations o JOIN sources s ON s.id = o.source_id JOIN properties pr ON pr.id = o.entity_id
                             WHERE pr.parcel_key = '1703290757' AND o.field = 'units' AND s.slug = 'wake-parcels' ORDER BY o.id`);
      assert.deepStrictEqual(vals.map((v) => v.value), [115, 120]);
      assert.ok(/wake-parcels 1703290757 says 120/.test((await conflict('1703290757', 'units')).resolution));
      await q("UPDATE parcels SET units = 115, fetched_at = now() WHERE parcel_key = '1703290757'");
      await runFields();
      assert.ok(/wake-parcels 1703290757 says 115/.test((await conflict('1703290757', 'units')).resolution));
    });

    await check('a reviewed conflict keeps its review while the same observations disagree; gone when they agree', async () => {
      await q("UPDATE field_conflicts SET status = 'reviewed' WHERE field = 'units'");
      await runFields();
      assert.strictEqual((await conflict('1703290757', 'units')).status, 'reviewed');
      await q("UPDATE permit_facts SET units = 115 WHERE units = 120");
      await runFields();
      assert.strictEqual(await conflict('1703290757', 'units'), undefined);
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
