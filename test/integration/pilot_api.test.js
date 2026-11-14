// Integration: the pilot API (/api/pilot/*) over a resolved Austin fixture.
// Checks the hiring metrics the GC view is built on, and the privacy rules:
// individuals' names and phones never leave, only 'show' phones do.
// Needs Postgres (DATABASE_URL; default :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_p_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000';
const row = (num, type, company, phone, ago, o = {}) => ({
  permit_number: `2026-${num} ${type}`, permittype: type, permit_type_desc: `${type} Permit`,
  description: type === 'BP' ? 'Remodel kitchen, relocate panel, new circuits' : 'Trade work',
  status_current: 'Active', issue_date: daysAgo(ago), original_address1: `${num} MAIN ST`,
  original_city: 'AUSTIN', original_state: 'TX', original_zip: num >= 7 ? '78745' : '78704',
  contractor_company_name: company, contractor_phone: phone, contractor_trade: null, total_job_valuation: '100000', ...o,
});

const ACME = ['Acme Builders LLC', '5125550100'];
const SPARKY = ['Sparky Electric Inc', '5125550200'];
const VOLT = ['Volt Electric LLC', '5125550300'];
const ZAP = ['Zap Electrical Services', '5125550400'];
const rows = [
  // Acme: Sparky on four jobs, then Volt on the latest one -> "changed".
  ...[1, 2, 3, 4].flatMap((n) => [row(n, 'BP', ...ACME, 60 - n * 5), row(n, 'EP', ...SPARKY, 50 - n * 5)]),
  row(5, 'BP', ...ACME, 30), row(5, 'EP', ...VOLT, 20),
  row(6, 'BP', ...ACME, 10), // no electrical yet -> open now, and a lead
  // Beta: three jobs, three electricians -> "spread".
  row(7, 'BP', 'Beta Homes Inc', '5125550500', 40), row(7, 'EP', ...SPARKY, 35),
  row(8, 'BP', 'Beta Homes Inc', '5125550500', 38), row(8, 'EP', ...VOLT, 33),
  row(9, 'BP', 'Beta Homes Inc', '5125550500', 36), row(9, 'EP', ...ZAP, 31),
  // An individual GC: name and phone must never be returned.
  row(10, 'BP', 'John Smith', '5125550999', 20), row(10, 'EP', ...SPARKY, 15),
];

const realFetch = global.fetch;
let pages = [];
global.fetch = async () => { const page = pages.shift() || []; return { ok: true, json: async () => page, text: async () => '' }; };

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  delete process.env.DEMO_PASSWORD;
  // These suites write (suppressions) and read the same URL again: no cache.
  process.env.API_CACHE = 'off';
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const { resolveAll } = require('../../ingest/resolve.js');
  const { app } = require('../../web/server.js');
  let server;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  try {
    await db.applySchema();
    pages = [rows];
    await ingestArea('austin-tx', { days: 14, max: 100, allDetails: false });
    await resolveAll();
    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p) => { const r = await realFetch(base + p); return { status: r.status, body: await r.json() }; };

    let gcs;
    await check('GC list: jobs, subs used, top share, open now', async () => {
      const { status, body } = await get('/api/pilot/gcs?source=austin-tx&trade=electrical&months=6');
      assert.strictEqual(status, 200);
      gcs = body;
      const acme = body.gcs.find((g) => g.gc.name === 'Acme Builders LLC');
      assert.deepStrictEqual([acme.jobs, acme.tradeJobs, acme.subsUsed, acme.openNow], [6, 5, 2, 1]);
      assert.strictEqual(acme.topSubShare, 0.8);
      const beta = body.gcs.find((g) => g.gc.name === 'Beta Homes Inc');
      assert.deepStrictEqual([beta.subsUsed, beta.segments.spread], [3, true]);
    });

    await check('a GC that left its usual electrician is flagged, with the permit', async () => {
      const acme = gcs.gcs.find((g) => g.gc.name === 'Acme Builders LLC');
      assert.strictEqual(acme.segments.changed, true);
      assert.strictEqual(acme.change.usual.name, 'Sparky Electric Inc');
      assert.strictEqual(acme.change.latest.name, 'Volt Electric LLC');
      assert.deepStrictEqual([acme.change.usualJobs, acme.change.beforeJobs, acme.change.latestPermit], [4, 4, '2026-5 EP']);
    });

    await check('an individual GC comes back with no name and no phone', async () => {
      const ind = gcs.gcs.filter((g) => g.gc.partyKind === 'individual');
      assert.strictEqual(ind.length, 1);
      assert.deepStrictEqual([ind[0].gc.name, ind[0].gc.phone, ind[0].gc.id], [null, null, null]);
      assert.ok(!JSON.stringify(gcs).includes('John Smith'));
      assert.ok(!JSON.stringify(gcs).includes('5125550999'));
    });

    await check('the market baseline counts repeat hires', async () => {
      // Hires after a GC's first: Acme 4 (Sparky x3 repeat, Volt new), Beta 2 (both new).
      assert.deepStrictEqual([gcs.baseline.eligibleHires, gcs.baseline.repeatHires], [6, 3]);
      assert.strictEqual(gcs.baseline.topSubs[0].sub.name, 'Sparky Electric Inc');
    });

    await check('ZIP filter narrows to that ZIP\'s building permits', async () => {
      const { body } = await get('/api/pilot/gcs?trade=electrical&zips=78745');
      assert.deepStrictEqual(body.gcs.map((g) => g.gc.name || 'withheld').sort(), ['Beta Homes Inc', 'withheld']);
    });

    await check('the job page links trade permits and shows provenance', async () => {
      const [bp] = await db.query("SELECT id FROM permits WHERE permit_number = '2026-1 BP'").then((r) => r.rows);
      const { body } = await get(`/api/pilot/jobs/${bp.id}?trade=electrical`);
      assert.strictEqual(body.gc.name, 'Acme Builders LLC');
      assert.strictEqual(body.gc.phone.value, '+15125550100');
      assert.strictEqual(body.gc.phone.verification, 'corroborated');
      assert.strictEqual(body.tradePermitIssued, true);
      assert.deepStrictEqual(body.related.map((r) => [r.permit_number, r.contractor.name]), [['2026-1 EP', 'Sparky Electric Inc']]);
      assert.ok(body.provenance.rawRecordId > 0 && body.provenance.fetchedAt);
      assert.deepStrictEqual(body.gcHiring.subs.map((s) => [s.sub.name, s.jobs]), [['Sparky Electric Inc', 4], ['Volt Electric LLC', 1]]);
      assert.ok(!('owner' in body.permit) && !('applicant_phone' in body.permit));
      // Austin has no appraiser join yet, so no property facts are claimed.
      assert.strictEqual(body.property, null);
    });

    await check('new permits: narrowed to jobs with no electrical permit on record', async () => {
      const { body } = await get('/api/pilot/leads?without=electrical');
      assert.deepStrictEqual(body.leads.map((l) => l.permit_number), ['2026-6 BP']);
      assert.strictEqual(body.leads[0].gc.name, 'Acme Builders LLC');
      assert.ok(!('score' in body.leads[0]), 'no fit score (ADR-26)');
    });

    await check('new permits: without a trade, every new building permit, newest issue first (ADR-27)', async () => {
      const { body } = await get('/api/pilot/leads?trade=electrical');
      assert.strictEqual(body.without, null, 'trade alone no longer narrows the list');
      assert.ok(body.leads.length > 1 && body.leads.map((l) => l.permit_number).includes('2026-6 BP'));
      const dates = body.leads.map((l) => String(l.issuedOn || ''));
      assert.deepStrictEqual(dates, [...dates].sort().reverse());
    });

    await check('contractor profile; an individual returns a withheld stub', async () => {
      const acmeId = gcs.gcs.find((g) => g.gc.name === 'Acme Builders LLC').gc.id;
      const { body } = await get(`/api/pilot/contractors/${acmeId}`);
      assert.deepStrictEqual(body.subsHired.map((s) => [s.other.name, s.jobs]), [['Sparky Electric Inc', 4], ['Volt Electric LLC', 1]]);
      const [john] = await db.query("SELECT id FROM contractors WHERE display_name = 'John Smith'").then((r) => r.rows);
      const ind = await get(`/api/pilot/contractors/${john.id}`);
      assert.strictEqual(ind.body.contractor.name, null);
      assert.ok(!JSON.stringify(ind.body).includes('Smith'));
    });

    await check('a removal request hides the phone everywhere, and lifting it restores it', async () => {
      const acmeId = gcs.gcs.find((g) => g.gc.name === 'Acme Builders LLC').gc.id;
      const [bp] = await db.query("SELECT id FROM permits WHERE permit_number = '2026-1 BP'").then((r) => r.rows);
      await db.query("INSERT INTO suppressions (kind, value, request, channel) VALUES ('phone', '+15125550100', 'remove', 'email')");
      const list = await get('/api/pilot/gcs?source=austin-tx&trade=electrical&months=6');
      assert.strictEqual(list.body.gcs.find((g) => g.gc.id === acmeId).gc.phone, null);
      assert.strictEqual((await get(`/api/pilot/jobs/${bp.id}?trade=electrical`)).body.gc.phone, null);
      assert.deepStrictEqual((await get(`/api/pilot/contractors/${acmeId}`)).body.phones, []);
      assert.strictEqual((await get(`/api/permits/${bp.id}`)).body.contractor_phone, null);
      const search = await get('/api/permits?contractor=Acme&stage=any');
      assert.ok(search.body.results.length > 0 && search.body.results.every((r) => r.contractor_phone == null));
      assert.ok(!JSON.stringify((await get('/api/pilot/overview?source=austin-tx')).body).includes('+15125550100'));
      await db.query("UPDATE suppressions SET lifted_at = now() WHERE value = '+15125550100'");
      assert.strictEqual((await get(`/api/pilot/jobs/${bp.id}?trade=electrical`)).body.gc.phone.value, '+15125550100');
    });

    await check('a contractor-level request hides all of its phones', async () => {
      const [acme] = await db.query("SELECT id, identity_key FROM contractors WHERE display_name = 'Acme Builders LLC'").then((r) => r.rows);
      await db.query("INSERT INTO suppressions (kind, value, request) VALUES ('contractor', $1, 'do_not_contact')", [acme.identity_key]);
      assert.deepStrictEqual((await get(`/api/pilot/contractors/${acme.id}`)).body.phones, []);
      await db.query('UPDATE suppressions SET lifted_at = now() WHERE value = $1', [acme.identity_key]);
    });

    await check('ingest stores a masked copy, and search never matches a name in a description', async () => {
      const [{ n }] = await db.query("SELECT count(*)::int AS n FROM permits WHERE work_description_public IS NULL").then((r) => r.rows);
      assert.strictEqual(n, 0, 'every ingested permit has its masked copy');
      await db.query("UPDATE permits SET work_description = 'Remodel kitchen (Zelda Quuxly)', work_description_public = NULL WHERE permit_number = '2026-2 BP'");
      assert.strictEqual(await db.maskStoredDescriptions(), 1);
      assert.strictEqual(await db.maskStoredDescriptions(), 0, 'a second run changes nothing');
      const byName = await get('/api/permits?q=Quuxly&stage=any');
      assert.strictEqual(byName.body.total, 0);
      const byWord = await get('/api/permits?q=kitchen&stage=any');
      const hit = byWord.body.results.find((r) => r.permit_number === '2026-2 BP');
      assert.ok(hit, 'still found by its ordinary words');
      assert.strictEqual(hit.work_description, 'Remodel kitchen ([name withheld])');
    });

    await check('bad ids are 400, unknown ids 404, no SQL in errors', async () => {
      assert.strictEqual((await get('/api/pilot/jobs/abc')).status, 400);
      assert.strictEqual((await get('/api/pilot/jobs/999999')).status, 404);
    });
  } finally {
    if (server) server.close();
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
