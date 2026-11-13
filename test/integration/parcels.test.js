// Integration: property enrichment through real ingest + enrich runs against
// stubbed ArcGIS endpoints (Miami-Dade permits, then the Property Appraiser).
// Needs Postgres (DATABASE_URL; default :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_p_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const fixture = require('../fixtures/sources/miami-dade-fl.json');
const rows = fixture.rows.slice(0, 6).map((r) => ({ ...r, PermitIssuedDate: Date.now() - 86400000 }));
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ features: rows.map((attributes) => ({ attributes })) }) });

// The appraiser stub knows every folio but the last, and records what was asked.
const asked = [];
const folios = [...new Set(rows.map((r) => r.FolioNumber))];
const paFetch = async (url, init) => {
  const u = new URL(url);
  if (!u.pathname.endsWith('/query')) return { ok: true, status: 200, json: async () => ({ editingInfo: { lastEditDate: Date.UTC(2026, 10, 12) } }) };
  assert.strictEqual(init && init.method, 'POST');
  const form = new URLSearchParams(init.body);
  const keys = [...form.get('where').matchAll(/'(\d+)'/g)].map((m) => m[1]);
  asked.push({ keys, outFields: form.get('outFields') });
  const known = keys.filter((k) => k !== folios[folios.length - 1]);
  return { ok: true, status: 200, json: async () => ({ features: known.map((k) => ({
    attributes: { FOLIO: k, DOR_CODE_CUR: '0101', DOR_DESC: 'RESIDENTIAL - SINGLE FAMILY', YEAR_BUILT: 1961, BUILDING_HEATED_AREA: 1500, ASSESSED_VAL_CUR: 300000, TRUE_SITE_ZIP_CODE: '33155' },
    geometry: { x: -80.3, y: 25.7 },
  })) }) };
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
    await ingestArea('miami-dade-fl', { days: 14, max: 100, allDetails: false });

    await check('first run fetches each folio once, without owner fields, and links permits', async () => {
      const s = await enrichParcels({ fetchImpl: paFetch });
      assert.strictEqual(asked.length, 1);
      assert.ok(!/owner/i.test(asked[0].outFields));
      assert.deepStrictEqual([s.requested, s.found, s.distinctKeys], [folios.length, folios.length - 1, folios.length]);
      const [{ n }] = await q("SELECT count(*)::int AS n FROM permit_parcels WHERE provider = 'miami-dade-pa'");
      assert.strictEqual(n, rows.filter((r) => r.FolioNumber !== folios[folios.length - 1]).length);
    });

    await check('an unknown folio is remembered as not found, and nothing is invented for it', async () => {
      const [p] = await q('SELECT found, year_built, payload FROM parcels WHERE parcel_key = $1', [folios[folios.length - 1]]);
      assert.deepStrictEqual([p.found, p.year_built, p.payload], [false, null, {}]);
    });

    await check('a second run inside the refresh window asks for nothing', async () => {
      const s = await enrichParcels({ fetchImpl: paFetch });
      assert.deepStrictEqual([s.requested, asked.length], [0, 1]);
    });

    await check('the job API shows the parcel facts with their source and date, never an owner', async () => {
      const { getJob, parseFilters } = require('../../db/pilot_queries.js');
      const [{ permit_id: id }] = await q("SELECT permit_id FROM permit_parcels LIMIT 1");
      const job = await getJob(id, parseFilters({ trade: 'electrical', source: 'miami-dade-fl' }));
      assert.deepStrictEqual([job.property.yearBuilt, job.property.heatedSqft, job.property.landUse, job.property.siteZip],
        [1961, 1500, 'RESIDENTIAL - SINGLE FAMILY', '33155']);
      assert.strictEqual(job.property.provenance.source, 'miami-dade-pa');
      assert.ok(job.property.provenance.fetchedAt && job.property.provenance.attribution);
      assert.ok(!JSON.stringify(job.property).match(/owner/i));
    });

    await check('runs are recorded for the provider, and a failure carries its error class', async () => {
      await assert.rejects(enrichParcels({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) }));
      const runs = await q("SELECT r.status, r.error_class FROM sync_runs r JOIN sources s ON s.id = r.source_id WHERE s.slug = 'miami-dade-pa' ORDER BY r.id");
      assert.deepStrictEqual(runs.map((r) => r.status), ['succeeded', 'succeeded', 'failed']);
      assert.strictEqual(runs[2].error_class, 'transient');
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
