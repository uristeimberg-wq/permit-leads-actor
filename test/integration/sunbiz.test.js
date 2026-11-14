// Integration: Florida Sunbiz entity keys (migration 027) against a stubbed
// SFTP layer serving fixed-width lines built to the published layout.
// Contractors are inserted directly. Needs Postgres (DATABASE_URL; default :5433).

const assert = require('node:assert');
const fs = require('fs');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_sunbiz_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

/** One 1440-character corporate record; officer positions carry a marker that must never be stored. */
function rec({ no, name, status = 'A', type = 'FLAL', city = 'MIAMI', filed = '01152019' }) {
  let l = no.padEnd(12) + name.padEnd(192) + status + type.padEnd(15) + ' '.repeat(84) + city.padEnd(28) + 'FL' + '33101'.padEnd(10) + 'US'
    + ' '.repeat(84) + city.padEnd(28) + 'FL' + '33101'.padEnd(10) + 'US' + filed + '12-3456789'.padEnd(14) + 'N' + '03012024' + 'FL' + '2024';
  l = l.padEnd(544) + 'AGENT PERSON NAME'.padEnd(42);
  return l.padEnd(1440);
}

function stubIo(files) {
  const listed = (dir) => Object.keys(files).filter((f) => f.startsWith(`${dir}/`)).map((f) => ({ name: f.slice(dir.length + 1), size: 1, date: files[f].date }));
  return {
    downloads: [],
    async list(dir) { return listed(dir); },
    async download(file, to) { this.downloads.push(file); fs.writeFileSync(to, files[file].lines.join('\n')); return to; },
    async *lines(p) { for (const l of fs.readFileSync(p, 'latin1').split('\n')) if (l.trim()) yield l; },
  };
}

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { enrichSunbiz, coverage, parseListing } = require('../../ingest/enrich_sunbiz.js');
  const { resolveAll } = require('../../ingest/resolve.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  const files = {
    'doc/Quarterly/Cor/cordata.zip': { date: '2026-10-05', lines: [
      rec({ no: 'P13000012345', name: 'NEXTEP ELECTRIC, INC.', type: 'DOMP' }),
      rec({ no: 'L20000000001', name: 'TWIN PEAKS LLC' }),
      rec({ no: 'P99000000002', name: 'TWIN PEAKS, INC.', type: 'DOMP' }),
      rec({ no: 'L10000000003', name: 'OLD ROOF LLC', status: 'I' }),
      rec({ no: 'L21000000004', name: 'OLD ROOF, L.L.C.' }),
      rec({ no: 'L22000000005', name: 'UNRELATED HOLDINGS LLC' }),
    ] },
    'doc/cor/20261112c.txt': { date: '2026-11-12', lines: [rec({ no: 'P13000012345', name: 'NEXTEP ELECTRIC, INC.', status: 'I', type: 'DOMP' })] },
    'doc/cor/20261113c.txt': { date: '2026-11-13', lines: [rec({ no: 'L26000000009', name: 'NEXTEP ELECTRIC LLC' })] },
  };
  try {
    await db.applySchema();
    const src = (await q("SELECT id FROM sources WHERE slug = 'miami-dade-fl'"))[0];
    assert.ok(src, 'miami-dade-fl source exists');
    await q(`INSERT INTO contractors (identity_key, display_name, normalized_name, party_kind, business_state, permit_count, resolver_version) VALUES
      ('lic:FL:EC1', 'NEXTEP ELECTRIC INC', 'nextep electric', 'business', 'FL', 9, 't'),
      ('name:FL:twin peaks', 'Twin Peaks', 'twin peaks', 'business', 'FL', 3, 't'),
      ('name:FL:old roof', 'Old Roof LLC', 'old roof', 'business', 'FL', 2, 't'),
      ('name:FL:jane doe', 'Jane Doe', 'jane doe', 'individual', 'FL', 4, 't'),
      ('name:TX:nextep electric', 'Nextep Electric', 'nextep electric', 'business', 'TX', 4, 't')`);

    await check('a listing line parses to name, size and date', async () => {
      const [f] = parseListing('-rw-r--r--    1 nobody   nobody    123456 Nov 13 21:04 20261113c.txt', new Date('2026-11-14T00:00:00Z'));
      assert.deepStrictEqual([f.name, f.size, f.date], ['20261113c.txt', 123456, '2026-11-13']);
      const [g] = parseListing('-rw-r--r--    1 nobody   nobody    9 Oct  5  2026 cordata.zip');
      assert.strictEqual(g.date, '2026-10-05');
    });

    const io = stubIo(files);
    await check('first run: full scan, then the daily files in order; one entity links, two-of-a-name does not', async () => {
      const s = await enrichSunbiz({ io, now: new Date('2026-11-14T18:00:00Z') });
      assert.deepStrictEqual(io.downloads, ['doc/Quarterly/Cor/cordata.zip', 'doc/cor/20261112c.txt', 'doc/cor/20261113c.txt']);
      assert.deepStrictEqual([s.full.records, s.full.kept], [6, 5]);
      const lu = Object.fromEntries((await q("SELECT query_key, outcome, registry_id, candidates FROM registry_lookups WHERE provider = 'fl-sunbiz'"))
        .map((r) => [r.query_key, [r.outcome, r.registry_id, r.candidates]]));
      // Nextep: the daily file added a second "Nextep Electric" entity and made the first inactive -> one active of two.
      assert.deepStrictEqual(lu['nextep electric'], ['matched', 'L26000000009', 2]);
      assert.deepStrictEqual(lu['twin peaks'], ['ambiguous', null, 2]);
      assert.deepStrictEqual(lu['old roof'], ['matched', 'L21000000004', 2]);
      assert.ok(!lu['jane doe'], 'individual-looking names are never matched');
      const links = await q(`SELECT c.identity_key, g.registry_id, cr.match_rule FROM contractor_registrations cr
                               JOIN contractors c ON c.id = cr.contractor_id JOIN business_registrations g ON g.id = cr.registration_id ORDER BY 1`);
      assert.deepStrictEqual(links.map((l) => [l.identity_key, l.registry_id, l.match_rule]),
        [['lic:FL:EC1', 'L26000000009', 'name_state_active'], ['name:FL:old roof', 'L21000000004', 'name_state_active']]);
      const [n] = await q("SELECT sos_status, entity_type, source_as_of::text AS asof FROM business_registrations WHERE registry_id = 'P13000012345'");
      assert.deepStrictEqual(n, { sos_status: 'INACTIVE', entity_type: 'DOMP', asof: '2026-11-12' });
    });

    await check('nothing from the agent or officer positions is stored', async () => {
      const dump = JSON.stringify(await q('SELECT * FROM business_registrations'));
      assert.ok(!/AGENT PERSON|3456789/.test(dump));
    });

    await check('a re-run the same day downloads no daily file twice and changes nothing', async () => {
      io.downloads.length = 0;
      const s = await enrichSunbiz({ io, now: new Date('2026-11-14T19:00:00Z') });
      assert.deepStrictEqual(io.downloads, []);
      assert.strictEqual(s.linked, 2);
      assert.strictEqual((await q("SELECT count(*)::int AS n FROM business_registrations WHERE provider = 'fl-sunbiz'"))[0].n, 6);
    });

    await check('an older quarterly file never overwrites a newer daily record', async () => {
      io.downloads.length = 0;
      await enrichSunbiz({ io, full: true, now: new Date('2026-11-14T20:00:00Z') });
      const [n] = await q("SELECT sos_status FROM business_registrations WHERE registry_id = 'P13000012345'");
      assert.strictEqual(n.sos_status, 'INACTIVE');
    });

    await check('a file whose lines fail the layout is refused and the run fails as schema', async () => {
      const bad = stubIo({ ...files, 'doc/cor/20261114c.txt': { date: '2026-11-14', lines: ['short line', 'another'] } });
      await assert.rejects(enrichSunbiz({ io: bad, now: new Date('2026-11-14T21:00:00Z') }), /schema/);
      const [r] = await q("SELECT status, error_class FROM sync_runs WHERE source_id = (SELECT id FROM sources WHERE slug = 'fl-sunbiz') ORDER BY id DESC LIMIT 1");
      assert.deepStrictEqual(r, { status: 'failed', error_class: 'schema' });
    });

    await check('coverage counts Florida businesses only', async () => {
      const c = await coverage();
      assert.deepStrictEqual([c.businesses, c.verified], [3, 2]);
    });

    await check('the resolver reads the one-entity names (contractors-v5) and runs before any raw record', async () => {
      // Only one-candidate names are merge keys; here every match has 2, so none.
      assert.strictEqual((await resolveAll()).legalEntityNames, 0);
    });

    await check('one Sunbiz entity joins a City of Miami firm to its Miami-Dade licence holder; architects stored by rule 5', async () => {
      const md = (await q("SELECT id FROM sources WHERE slug = 'miami-dade-fl'"))[0].id;
      const city = (await q("SELECT id FROM sources WHERE slug = 'miami-city-fl'"))[0].id;
      const [run] = await q("INSERT INTO sync_runs (source_id, kind, status) VALUES ($1, 'manual', 'running') RETURNING id", [md]);
      const raw = async (sourceId, area, key, payload) => {
        await q(`INSERT INTO raw_records (source_id, source_key, payload_hash, payload, sync_run_id) VALUES ($1, $2, md5($3::text), $3::jsonb, $4)`,
          [sourceId, key, JSON.stringify(payload), run.id]);
        await q('INSERT INTO permits (source_area, permit_number) VALUES ($1, $2)', [area, key]);
      };
      await raw(md, 'miami-dade-fl', 'MD1', { PermitNumber: 'MD1', PermitType: 'ELEC', ContractorName: 'NEXTEP ELECTRIC INC', ContractorNumber: 'EC13001234', ArchitectName: 'PPK ARCHITECTS', MasterPermitNumber: '0000000000' });
      await raw(md, 'miami-dade-fl', 'MD2', { PermitNumber: 'MD2', PermitType: 'ELEC', ContractorName: 'NEXTEP ELECTRIC INC', ContractorNumber: 'EC13001234', ArchitectName: 'Jane Doe', MasterPermitNumber: '0000000000' });
      await raw(md, 'miami-dade-fl', 'MD3', { PermitNumber: 'MD3', PermitType: 'BLDG', ContractorName: 'X BUILDERS LLC', ContractorNumber: 'CGC1', ArchitectName: 'NOT LISTED', MasterPermitNumber: '0000000000' });
      await raw(city, 'miami-city-fl', 'BD26000001001E001', { PermitNumber: 'BD26000001001E001', ApplicationNumber: 'BD26000001', CompanyName: 'Nextep Electric, Inc.' });
      await q(`INSERT INTO registry_lookups (provider, query_key, query_text, outcome, registry_id, candidates, sync_run_id)
               VALUES ('fl-sunbiz', 'nextep electric', 'nextep electric', 'matched', 'P13000012345', 1, $1)
               ON CONFLICT (provider, query_key) DO UPDATE SET candidates = 1, registry_id = 'P13000012345', outcome = 'matched'`, [run.id]);
      const s = await resolveAll();
      assert.strictEqual(s.legalEntityParties, 1);
      const cs = await q("SELECT identity_key, permit_count FROM contractors WHERE permit_count > 0 AND normalized_name = 'nextep electric' AND business_state = 'FL'");
      assert.deepStrictEqual(cs, [{ identity_key: 'lic:FL:EC13001234', permit_count: 3 }]);
      const [cityParty] = await q("SELECT match_rule, match_confidence::float AS c FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id WHERE p.source_area = 'miami-city-fl'");
      assert.deepStrictEqual(cityParty, { match_rule: 'legal_entity', c: 0.85 });
      const arch = await q(`SELECT p.permit_number, a.raw_name, a.display_policy FROM permit_participants a JOIN permits p ON p.id = a.permit_id ORDER BY 1`);
      assert.deepStrictEqual(arch.map((a) => [a.permit_number, a.raw_name, a.display_policy]), [['MD1', 'PPK ARCHITECTS', 'show'], ['MD2', 'Jane Doe', 'hide']]);
      assert.strictEqual(s.architectsWritten, 2);
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
