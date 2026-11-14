// Integration: the rolling re-read (ingest/refresh.js, migration 030). A City
// of Miami sync from the recorded fixture, the permits aged past the sync
// windows, then a re-read against a stubbed layer where the City has moved
// one permit to "Final" and removed another. Also the 030 repair of Austin
// record links stored as JSON text. Needs Postgres (DATABASE_URL; default :5433).

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_rr_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const fx = require('../fixtures/sources/miami-city-fl.json');
const rows = fx.rows.map((r) => r.attributes || r);
const keys = rows.map((r) => r.PermitNumber);

// The window sync: the IssuedDate window returns the fixture, Statusdate nothing.
global.fetch = async (url) => {
  const where = new URL(url).searchParams.get('where') || '';
  const features = where.startsWith('IssuedDate') ? rows.map((attributes) => ({ attributes })) : [];
  return { ok: true, status: 200, json: async () => ({ features }), text: async () => '' };
};

// The live layer for the re-read: `live` decides what each key returns now.
let live = new Map();
const asked = [];
const layer = async (url, init) => {
  if (url.endsWith('?f=json')) return { ok: true, status: 200, json: async () => ({ fields: [{ name: 'PermitNumber', type: 'esriFieldTypeString' }] }) };
  const where = new URLSearchParams(init.body).get('where');
  const ks = [...where.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  asked.push(...ks);
  return { ok: true, status: 200, json: async () => ({ features: ks.filter((k) => live.has(k)).map((k) => ({ attributes: live.get(k) })) }) };
};

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const { refreshArea } = require('../../ingest/refresh.js');
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  try {
    await db.applySchema();
    await ingestArea('miami-city-fl', { days: 14, max: 100, allDetails: false });
    const [{ ok: windowSuccess }] = await q("SELECT max(finished_at) AS ok FROM sync_runs WHERE status = 'succeeded'");
    await q("UPDATE permits SET last_seen_at = now() - interval '10 days' WHERE source_area = 'miami-city-fl'");

    const active = rows.find((r) => r.BuildingPermitStatusDescription === 'Active');
    const gone = keys.find((k) => k !== active.PermitNumber);

    await check('a status the City changed after the window is caught; a removed permit is marked, not deleted', async () => {
      live = new Map(rows.map((r) => [r.PermitNumber, r]));
      live.set(active.PermitNumber, { ...active, BuildingPermitStatusDescription: 'Final', IsPermitFinal: 'YES', Statusdate: Date.now() });
      live.delete(gone);
      const s = await refreshArea('miami-city-fl', { fetchImpl: layer });
      assert.deepStrictEqual([s.asked, s.returned, s.missing, s.newlyMissing, s.statusChanged], [keys.length, keys.length - 1, 1, 1, 1]);
      const [p] = await q("SELECT status_raw, lifecycle_stage, source_missing_since FROM permits WHERE permit_number = $1", [active.PermitNumber]);
      assert.deepStrictEqual([p.status_raw, p.lifecycle_stage, p.source_missing_since], ['Final', 'completed', null]);
      const [g] = await q("SELECT source_missing_since, source_checked_at FROM permits WHERE permit_number = $1", [gone]);
      assert.ok(g.source_missing_since && g.source_checked_at, 'kept, and marked gone');
      const [{ n }] = await q("SELECT count(*)::int AS n FROM permits WHERE source_area = 'miami-city-fl' AND source_checked_at IS NULL");
      assert.strictEqual(n, 0, 'every permit asked about is checked');
      const [h] = await q("SELECT count(*)::int AS n FROM permit_status_history h JOIN permits p ON p.id = h.permit_id WHERE p.permit_number = $1", [active.PermitNumber]);
      assert.strictEqual(h.n, 2, 'the status change is in the history');
    });

    await check('the run is a refresh run with its raw versions and a missing-at-source event', async () => {
      const [r] = await q("SELECT kind, status, records_fetched, records_changed FROM sync_runs ORDER BY id DESC LIMIT 1");
      assert.deepStrictEqual([r.kind, r.status, r.records_fetched, r.records_changed], ['refresh', 'succeeded', keys.length - 1, 1]);
      const ev = await q("SELECT kind, severity, detail FROM source_events WHERE kind = 'missing_at_source'");
      assert.strictEqual(ev.length, 1);
      assert.deepStrictEqual(ev[0].detail.examples, [gone]);
    });

    await check('a re-read never makes a source look freshly synced', async () => {
      const [h] = await q("SELECT last_success_at FROM source_health WHERE slug = 'miami-city-fl'");
      assert.strictEqual(h.last_success_at.getTime(), windowSuccess.getTime());
    });

    await check('the next run asks only for what is due; a permit that stays gone is no error', async () => {
      asked.length = 0;
      const s = await refreshArea('miami-city-fl', { fetchImpl: layer });
      assert.deepStrictEqual(asked, [gone], 'the confirmed permits were seen just now');
      assert.deepStrictEqual([s.asked, s.returned, s.newlyMissing], [1, 0, 0]);
    });

    await check('a permit that comes back is no longer marked gone', async () => {
      live.set(gone, rows.find((r) => r.PermitNumber === gone));
      await refreshArea('miami-city-fl', { fetchImpl: layer });
      const [g] = await q("SELECT source_missing_since FROM permits WHERE permit_number = $1", [gone]);
      assert.strictEqual(g.source_missing_since, null);
    });

    await check('a source that answers nothing fails the run and marks nothing', async () => {
      await q("UPDATE permits SET last_seen_at = now() - interval '10 days' WHERE source_area = 'miami-city-fl'");
      live = new Map();
      await assert.rejects(refreshArea('miami-city-fl', { fetchImpl: layer }), /refused to mark/);
      const [r] = await q("SELECT kind, status, error_class FROM sync_runs ORDER BY id DESC LIMIT 1");
      assert.deepStrictEqual([r.kind, r.status, r.error_class], ['refresh', 'failed', 'bad_data']);
      const [{ n }] = await q("SELECT count(*)::int AS n FROM permits WHERE source_missing_since IS NOT NULL");
      assert.strictEqual(n, 0);
      const [h] = await q("SELECT last_status, consecutive_failures FROM source_health WHERE slug = 'miami-city-fl'");
      assert.deepStrictEqual([h.last_status, h.consecutive_failures], ['succeeded', 0], 'a failed re-read is reported by health, not as a failed sync');
    });

    await check('030 repairs record links stored as JSON text, and leaves real URLs alone', async () => {
      await q(`INSERT INTO permits (source_area, permit_number, permit_url) VALUES
               ('austin-tx', 'X-1 BP', '{"url":"https://abc.austintexas.gov/web/permit/public-search-other?t_detail=1&t_selected_folderrsn=1"}'),
               ('austin-tx', 'X-2 BP', 'https://abc.austintexas.gov/plain'), ('austin-tx', 'X-3 BP', '{"description":"no url"}')`);
      const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/030_rolling_reread.sql'), 'utf8');
      await q(sql.slice(sql.lastIndexOf('UPDATE permits')));
      const r = await q("SELECT permit_number, permit_url FROM permits WHERE permit_number LIKE 'X-%' ORDER BY 1");
      assert.deepStrictEqual(r.map((x) => x.permit_url), [
        'https://abc.austintexas.gov/web/permit/public-search-other?t_detail=1&t_selected_folderrsn=1',
        'https://abc.austintexas.gov/plain', '{"description":"no url"}']);
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
