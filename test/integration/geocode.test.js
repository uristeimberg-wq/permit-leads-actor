// Integration: permit locations through a real Austin ingest and geocode runs
// against a stubbed Census batch endpoint. Needs Postgres (DATABASE_URL;
// default :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_g_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const row = (num, street, o = {}) => ({
  permit_number: `2026-${num} BP`, permittype: 'BP', permit_type_desc: 'BP Permit', description: 'Kitchen remodel',
  status_current: 'Active', issue_date: '2026-11-01T00:00:00.000', original_address1: street,
  original_city: 'AUSTIN', original_state: 'TX', original_zip: '78701',
  contractor_company_name: 'Acme Builders LLC', contractor_phone: '5125550100',
  contractor_address1: '999 CONTRACTOR WAY', contractor_city: 'AUSTIN', contractor_zip: '78702', ...o,
});
const austin = [
  row(1, '100 MAIN ST', { latitude: '30.27', longitude: '-97.74' }), // the source's own point
  row(2, '200 OAK ST'), // Census: exact
  row(3, '200 OAK ST'), // same address: asked once
  row(4, '300 ELM ST'), // Census: no match
  row(5, '400 PINE ST'), // Census: tie, which is not a match
  row(6, 'MAIN ST AND 5TH'), // no house number: never sent
  row(7, '500 BAY ST', { latitude: '0', longitude: '0' }), // a 0,0 point is not a place: Census instead
  row(8, '200 OAK ST UNIT 4'), // a unit on a known address: same key, not asked again
];
global.fetch = async () => ({ ok: true, json: async () => austin, text: async () => '' });

const sent = [];
const census = (answer) => async (url, init) => {
  const csv = await init.body.get('addressFile').text();
  sent.push({ url, benchmark: init.body.get('benchmark'), csv });
  const lines = csv.split('\n').map((l) => l.split('","').map((f) => f.replace(/"/g, '')));
  return { ok: true, status: 200, text: async () => answer(lines) };
};
const answers = (lines) => lines.map(([id, street, city, state, zip]) => {
  const input = `"${id}","${street}, ${city}, ${state}, ${zip}"`;
  if (street.startsWith('200 OAK')) return `${input},"Match","Exact","200 OAK ST, AUSTIN, TX, 78701","-97.75,30.28","1","L"`;
  if (street.startsWith('400 PINE')) return `${input},"Tie"`;
  if (street.startsWith('500 BAY')) return `${input},"Match","Non_Exact","500 BAY ST, AUSTIN, TX, 78701","-97.76,30.29","2","R"`;
  return `${input},"No_Match"`;
}).join('\n');

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const { geocodePermits } = require('../../ingest/geocode.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  const loc = async (num) => (await q(`SELECT l.* FROM permit_locations l JOIN permits p ON p.id = l.permit_id
    WHERE p.permit_number = $1`, [`2026-${num} BP`]))[0];
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  try {
    await db.applySchema();
    await ingestArea('austin-tx', { days: 14, max: 100, allDetails: false });

    await check('source points first; only job-site addresses without one go to the Census, each once', async () => {
      const s = await geocodePermits({ fetchImpl: census(answers) });
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].benchmark, 'Public_AR_Current');
      const streets = sent[0].csv.split('\n').map((l) => l.split(',')[1]).sort();
      assert.deepStrictEqual(streets, ['"200 OAK ST"', '"300 ELM ST"', '"400 PINE ST"', '"500 BAY ST"']);
      assert.ok(!/CONTRACTOR WAY/.test(sent[0].csv), 'a contractor business address was sent to the Census');
      assert.deepStrictEqual([s.asked, s.matched, s.byMethod], [4, 2, { source: 1, census: 4 }]);
      assert.deepStrictEqual(s.misses['austin-tx'].reasons, { no_match: 1, tie: 1, no_house_number_or_place: 1 });
    });

    await check('each permit keeps its method; misses, ties and unplaceable addresses stay unlocated', async () => {
      assert.deepStrictEqual([(await loc(1)).method, (await loc(1)).lat], ['source', 30.27]);
      assert.deepStrictEqual([(await loc(2)).method, (await loc(2)).quality, (await loc(2)).lat], ['census', 'exact', 30.28]);
      assert.strictEqual((await loc(3)).lat, 30.28);
      assert.deepStrictEqual([(await loc(8)).method, (await loc(8)).lat], ['census', 30.28]);
      assert.deepStrictEqual([await loc(4), await loc(5), await loc(6)], [undefined, undefined, undefined]);
      assert.deepStrictEqual([(await loc(7)).method, (await loc(7)).quality], ['census', 'non_exact']);
      const [tie] = await q("SELECT matched, quality, lat FROM geocode_cache WHERE address_key LIKE '400 PINE%'");
      assert.deepStrictEqual(tie, { matched: false, quality: 'tie', lat: null });
    });

    await check('a second run asks the Census nothing and rewrites no row', async () => {
      const s = await geocodePermits({ fetchImpl: census(answers) });
      assert.deepStrictEqual([sent.length, s.asked, s.changed, s.removed], [1, 0, 0, 0]);
    });

    await check('the job API shows the point with its method and the Census notice', async () => {
      const { getJob, parseFilters } = require('../../db/pilot_queries.js');
      const [{ id }] = await q("SELECT id FROM permits WHERE permit_number = '2026-2 BP'");
      const job = await getJob(id, parseFilters({ trade: 'electrical', source: 'austin-tx' }));
      assert.deepStrictEqual([job.location.method, job.location.quality, job.location.provenance.source],
        ['census', 'exact', 'us-census-geocoder']);
      assert.match(job.location.provenance.attribution, /not endorsed or certified by the Census Bureau/);
      const [{ id: own }] = await q("SELECT id FROM permits WHERE permit_number = '2026-1 BP'");
      assert.strictEqual((await getJob(own, parseFilters({ trade: 'electrical', source: 'austin-tx' }))).location.provenance.source, 'austin-tx');
    });

    await check('an error page from the Census is a schema failure, recorded with its class', async () => {
      await q("UPDATE geocode_cache SET geocoded_at = now() - interval '40 days' WHERE NOT matched");
      await assert.rejects(geocodePermits({ fetchImpl: census(() => '<html>Service unavailable</html>') }), /schema/);
      const runs = await q("SELECT r.status, r.error_class FROM sync_runs r JOIN sources s ON s.id = r.source_id WHERE s.slug = 'us-census-geocoder' ORDER BY r.id");
      assert.deepStrictEqual(runs.map((r) => [r.status, r.error_class]), [['succeeded', null], ['succeeded', null], ['failed', 'schema']]);
      assert.strictEqual((await loc(2)).method, 'census'); // the failed run changed nothing
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
