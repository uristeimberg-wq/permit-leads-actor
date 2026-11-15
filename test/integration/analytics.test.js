// Integration: product analytics (ADR-37) against a real database, through
// the real server: batch ingestion and idempotency, active dwell time,
// zero-result searches, anonymous-to-user stitching on sign-in, internal and
// bot exclusion, the append-only guard, and the owner-only dashboard API.
// Needs Postgres (DATABASE_URL; default :5433). Uses a throwaway database.

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_an_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const OWNER = 'owner-it-key';
const uuid = (a, n) => `${a.repeat(8)}-${a.repeat(4)}-4${a.repeat(3)}-8${a.repeat(3)}-${String(n).padStart(12, '0')}`;
const D1 = uuid('d', 1); const D2 = uuid('e', 2);
const S1 = uuid('a', 1); const S2 = uuid('a', 2); const S3 = uuid('a', 3); const S4 = uuid('a', 4);
const at = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
let n = 0;
const ev = (name, props = {}, o = {}) => ({ event_id: uuid('c', ++n), event_name: name, client_timestamp: at(o.minAgo ?? 10), page_path: o.path || '/', properties: props, ...o.ctx });

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  process.env.DEMO_PASSWORD = OWNER;
  process.env.SESSION_SECRET = 'integration-test-secret';
  delete process.env.REQUIRE_LOGIN;
  const db = require('../../db/index.js');
  const { app } = require('../../web/server.js');
  let server;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  try {
    await db.applySchema();
    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (body, headers = {}) => fetch(`${base}/api/telemetry/events`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': CHROME, ...headers }, body: JSON.stringify(body),
    });
    const ownerAuth = { authorization: `Basic ${Buffer.from(`x:${OWNER}`).toString('base64')}` };
    const adminGet = async (p, headers = ownerAuth) => { const r = await fetch(base + p, { headers, redirect: 'manual' }); return { status: r.status, body: /json/.test(r.headers.get('content-type') || '') ? await r.json() : await r.text() }; };
    const one = async (sql, params) => (await db.query(sql, params)).rows[0];

    // An anonymous visit: lands, two searches (one finds nothing), opens a
    // permit, hides the tab (checkpoint at 4 s), comes back, leaves at 9 s.
    const first = {
      session_id: S1, anonymous_device_id: D1, session: { entry_path: '/', referrer: 'google.com', utm_source: 'newsletter' },
      events: [
        ev('page_view', { view_id: 'v1' }, { minAgo: 20 }),
        ev('search_executed', { query: 'solar farm', filters: { q: 'solar farm', areas: 'austin-tx' }, view: 'projects', results_count: 0, zero_results: true }, { minAgo: 19 }),
        ev('search_executed', { query: 'roof call 512-555-0100', filters: { q: 'roof', stage: 'pending,approved', areas: 'austin-tx' }, view: 'projects', results_count: 12, zero_results: false }, { minAgo: 18 }),
        ev('record_clicked', { position: 2 }, { minAgo: 17, ctx: { target_record_id: '123', target_entity_type: 'permit' } }),
        ev('record_detail_viewed', { read_time_ms: 7000 }, { minAgo: 16, ctx: { target_record_id: '123', target_entity_type: 'permit' } }),
        ev('page_exit', { view_id: 'v1', dwell_time_ms: 4000, final: false }, { minAgo: 15 }),
        ev('page_exit', { view_id: 'v1', dwell_time_ms: 9000, final: true }, { minAgo: 14 }),
      ],
    };

    await check('a batch is stored in one go: 202, every event, the session row', async () => {
      const r = await post(first);
      assert.strictEqual(r.status, 202);
      assert.deepStrictEqual(await r.json(), { accepted: 7, duplicates: 0 });
      const s = await one('SELECT * FROM analytics_sessions WHERE session_id = $1', [S1]);
      assert.strictEqual(s.anonymous_device_id, D1);
      assert.strictEqual(s.user_id, null);
      assert.strictEqual(s.referrer, 'google.com');
      assert.strictEqual(s.utm_source, 'newsletter');
      assert.deepStrictEqual([s.device_type, s.browser, s.os, s.is_bot, s.is_internal], ['desktop', 'Chrome', 'Windows', false, false]);
      assert.strictEqual(s.ip_country, null, 'no geo header configured, so no country');
    });

    await check('a retried batch writes nothing twice (ON CONFLICT event_id)', async () => {
      const r = await post(first);
      assert.deepStrictEqual(await r.json(), { accepted: 0, duplicates: 7 });
      assert.strictEqual((await one('SELECT count(*)::int AS n FROM analytics_events')).n, 7);
    });

    await check('active dwell: the longest checkpoint per page view, so 9 s, not 4 + 9', async () => {
      const s = await one('SELECT duration_seconds, exit_path, ended_at FROM analytics_sessions WHERE session_id = $1', [S1]);
      assert.strictEqual(s.duration_seconds, 9);
      assert.strictEqual(s.exit_path, '/');
      assert.ok(s.ended_at, 'the last event is a final exit');
    });

    await check('a phone number typed into the search is never stored', async () => {
      const { rows } = await db.query("SELECT properties->>'query' AS q FROM analytics_events WHERE event_name = 'search_executed' ORDER BY client_timestamp");
      assert.deepStrictEqual(rows.map((r) => r.q), ['solar farm', 'roof call [phone]']);
      assert.ok(!JSON.stringify((await db.query('SELECT * FROM analytics_events')).rows).includes('555-0100'));
    });

    await check('another device cannot write into this session (409)', async () => {
      const r = await post({ ...first, anonymous_device_id: D2, events: [ev('page_view')] });
      assert.strictEqual(r.status, 409);
    });

    let cookie;
    await check('sign-in stitches the device: earlier anonymous events and sessions get the user', async () => {
      const r = await fetch(`${base}/api/me/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'Dana@Example.com' }) });
      const body = await r.json();
      assert.deepStrictEqual(body, { email: 'dana@example.com', created: true });
      cookie = (r.headers.get('set-cookie') || '').split(';')[0];
      const again = await (await fetch(`${base}/api/me/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dana@example.com' }) })).json();
      assert.strictEqual(again.created, false, 'the second time is a login, not a signup');

      // The tracker's next batch (Track.identify) carries the cookie.
      const later = await post({ session_id: S2, anonymous_device_id: D1, session: { entry_path: '/saved' },
        events: [ev('login_succeeded', {}, { minAgo: 5 }), ev('page_view', { view_id: 'v2' }, { minAgo: 5, path: '/saved' }),
          ev('record_saved', {}, { minAgo: 4, ctx: { target_record_id: '123', target_entity_type: 'permit' } })] }, { cookie });
      assert.strictEqual(later.status, 202);
      const { id } = await one("SELECT id FROM app_users WHERE email = 'dana@example.com'");
      assert.strictEqual((await one('SELECT count(*)::int AS n FROM analytics_events WHERE user_id IS DISTINCT FROM $1', [id])).n, 0);
      assert.strictEqual((await one('SELECT count(*)::int AS n FROM analytics_sessions WHERE user_id = $1', [id])).n, 2);
      assert.strictEqual((await one('SELECT count(*)::int AS n FROM analytics_identities WHERE anonymous_device_id = $1 AND user_id = $2', [D1, id])).n, 1);
    });

    await check('events are append-only: only a missing user_id may be filled in', async () => {
      await assert.rejects(db.query("UPDATE analytics_events SET event_name = 'page_view' WHERE event_name = 'record_saved'"), /append-only/);
      // Re-assigning an event to another user is refused (clearing it is the FK's ON DELETE SET NULL).
      await assert.rejects(db.query('UPDATE analytics_events SET user_id = user_id + 1000 WHERE user_id IS NOT NULL'), /append-only/);
    });

    await check('owner traffic and bots are stored but marked, and left out of metrics', async () => {
      assert.strictEqual((await post({ session_id: S3, anonymous_device_id: uuid('f', 3), events: [ev('page_view'), ev('search_executed', { query: 'owner test', results_count: 0, zero_results: true })] }, ownerAuth)).status, 202);
      assert.strictEqual((await post({ session_id: S4, anonymous_device_id: uuid('b', 4), events: [ev('page_view')] }, { 'user-agent': 'Mozilla/5.0 HeadlessChrome/130' })).status, 202);
      const flags = (await db.query('SELECT session_id, is_internal, is_bot FROM analytics_sessions WHERE session_id IN ($1, $2) ORDER BY session_id', [S3, S4])).rows;
      assert.deepStrictEqual(flags.map((f) => [f.is_internal, f.is_bot]), [[true, false], [false, true]]);
    });

    await check('dashboard summary: real aggregates, zero-result table, funnel, conversion', async () => {
      const { status, body } = await adminGet('/api/admin/analytics/summary?range=all');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.totals.sessions, 2, 'internal and bot sessions excluded');
      assert.strictEqual(body.totals.actors, 1, 'one person after stitching');
      assert.strictEqual(body.totals.searches, 2);
      assert.deepStrictEqual(body.excluded, { internal: 1, bots: 1 });
      assert.deepStrictEqual(body.search.zero.map((z) => [z.query, z.times]), [['solar farm', 1]], 'the owner\'s zero-result test search is not there');
      assert.deepStrictEqual(body.search.terms.map((t) => t.term).sort(), ['roof call [phone]', 'solar farm']);
      assert.deepStrictEqual(body.search.areas, [{ area: 'austin-tx', searches: 2 }]);
      assert.deepStrictEqual(body.records.map((r) => [r.type, r.id, r.clicks, r.views, Number(r.read_ms)]), [['permit', '123', 1, 1, 7000]]);
      // Saved in the second session; no session after it yet, so no return.
      assert.deepStrictEqual(body.funnel, { landed: 1, searched: 1, opened: 1, intent: 1, returned: 0 });
      assert.deepStrictEqual(body.conversion, { devices: 1, registered: 1, rate: 1 });
      assert.strictEqual(body.activity.dau, 1);
      assert.strictEqual(body.activity.mau, 1);
      // One person, active on the only day of data: 100%, not 1/30.
      assert.strictEqual(body.activity.daysTracked, 1);
      assert.strictEqual(body.activity.stickiness, 1);
      assert.ok(body.paths.some((p) => p.from_path === '/' || p.to_path === '/saved') || body.paths.length === 0);
    });

    await check('per-user timeline: every session with its events in order', async () => {
      const { users } = (await adminGet('/api/admin/analytics/users')).body;
      assert.strictEqual(users.length, 1);
      assert.strictEqual(users[0].sessions, 2);
      assert.strictEqual(users[0].searches, 2);
      const t = (await adminGet(`/api/admin/analytics/users/${users[0].id}/timeline`)).body;
      assert.strictEqual(t.sessions.length, 2);
      const older = t.sessions[1];
      assert.deepStrictEqual(older.events.map((e) => e.event_name), ['page_view', 'search_executed', 'search_executed', 'record_clicked', 'record_detail_viewed', 'page_exit', 'page_exit']);
      const scoped = (await adminGet(`/api/admin/analytics/summary?range=all&user=${users[0].id}`)).body;
      assert.strictEqual(scoped.totals.events, 10);
    });

    await check('CSV export of real rows', async () => {
      const { status, body } = await adminGet('/api/admin/analytics/export.csv?kind=searches&range=all');
      assert.strictEqual(status, 200);
      const lines = body.trim().split('\r\n');
      assert.strictEqual(lines.length, 3, 'header + the two non-internal searches');
      assert.ok(lines.some((l) => l.includes('solar farm')));
    });

    await check('the dashboard and its API: 401 without a key, 403 for an email user', async () => {
      assert.strictEqual((await adminGet('/api/admin/analytics/summary', {})).status, 401);
      assert.strictEqual((await adminGet('/api/admin/analytics/summary', { cookie })).status, 403);
      assert.strictEqual((await adminGet('/admin/analytics', { cookie, accept: 'text/html' })).status, 302, 'a browser goes to the owner sign-in');
      assert.strictEqual((await adminGet('/admin/analytics', { accept: 'text/html' })).status, 302);
      assert.strictEqual((await adminGet('/admin/analytics', ownerAuth)).status, 200);
      assert.strictEqual((await adminGet('/api/permits?stage=any', {})).status, 200, 'the app itself stays open');
    });

    await check('retention: events and sessions past 13 months are deleted, newer ones kept', async () => {
      const { pruneAnalytics } = require('../../ingest/analytics_retention.js');
      const oldS = uuid('9', 9); const oldD = uuid('8', 8);
      await db.query(`INSERT INTO analytics_sessions (session_id, anonymous_device_id, started_at, last_active_at)
                      VALUES ($1, $2, now() - interval '14 months', now() - interval '14 months')`, [oldS, oldD]);
      await db.query(`INSERT INTO analytics_events (event_id, session_id, anonymous_device_id, event_name, event_category, client_timestamp, server_received_at)
                      VALUES ($1, $2, $3, 'page_view', 'navigation', now() - interval '14 months', now() - interval '14 months')`, [uuid('7', 7), oldS, oldD]);
      // A recent session with one event just past the window and one inside it.
      await db.query(`INSERT INTO analytics_events (event_id, session_id, anonymous_device_id, event_name, event_category, client_timestamp, server_received_at)
                      VALUES ($1, $2, $3, 'page_view', 'navigation', now() - interval '13 months 1 day', now() - interval '13 months 1 day')`, [uuid('6', 6), S1, D1]);
      const before = (await one('SELECT count(*)::int AS n FROM analytics_events')).n;
      const r = await pruneAnalytics(db.query, { batch: 1 });
      assert.deepStrictEqual([r.events, r.sessions], [2, 1]);
      assert.strictEqual((await one('SELECT count(*)::int AS n FROM analytics_events')).n, before - 2);
      assert.strictEqual((await one('SELECT count(*)::int AS n FROM analytics_sessions WHERE session_id = $1', [oldS])).n, 0);
      assert.strictEqual((await one('SELECT count(*)::int AS n FROM analytics_sessions WHERE session_id = $1', [S1])).n, 1, 'a recent session stays');
      assert.deepStrictEqual(await pruneAnalytics(db.query).then((x) => [x.events, x.sessions]), [0, 0], 'a re-run deletes nothing');
    });

    await check('the privacy page is public', async () => {
      const r = await fetch(`${base}/privacy`);
      assert.strictEqual(r.status, 200);
      assert.match(await r.text(), /Do Not Track/);
    });
  } finally {
    if (server) server.close();
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
