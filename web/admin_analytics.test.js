// /admin/analytics and /api/admin/analytics/*: owner only. Wired the way
// web/server.js wires them (open access, email users, ownerOnly), with a fake
// query function. No database.
const assert = require('node:assert');
const express = require('express');
const { demoGate } = require('./access.js');
const users = require('./users.js');
const admin = require('./admin_analytics.js');

let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log(`ok   - ${name}`); } catch (e) { failures += 1; console.error(`FAIL - ${name}`); console.error(e); } };
const basic = (s) => `Basic ${Buffer.from(s).toString('base64')}`;
const OWNER_ONLY = /^\/(digest\/(preview|sample)|admin|api\/admin)(\/|$)/;
const PATHS = ['/api/admin/analytics/summary?range=7d', '/api/admin/analytics/users', '/api/admin/analytics/users/1/timeline', '/api/admin/analytics/export.csv?kind=events'];

async function withApp(password, fn) {
  const sessions = users.sessions({ key: Buffer.from('k'.repeat(32)) });
  const store = { findOrCreate: async (email) => ({ id: 5, email }) };
  const gate = demoGate(password, {
    users: { store, sessions, normalEmail: users.normalEmail },
    isPublic: (req) => !OWNER_ONLY.test(req.path),
    ownerOnly: (req) => OWNER_ONLY.test(req.path),
  });
  const queries = [];
  const query = async (sql, params) => {
    queries.push(sql);
    if (/INSERT INTO analytics_internal_devices/.test(sql)) { queries.marks = (queries.marks || []).concat([params]); return { rows: [{ users: 1, sessions: 2 }] }; }
    if (/FROM app_users WHERE id = \$1/.test(sql)) return { rows: [{ id: 1, email: 'a@b.co', created_at: new Date(0) }] };
    return { rows: [] };
  };
  const app = express();
  app.set('trust proxy', 1);
  app.use(gate);
  app.use(admin.router({ query, isOwner: gate.isOwner, userIdOf: (req) => sessions.userId(req) }));
  app.get('/digest/preview', (_req, res) => res.json({ ok: true }));
  app.get('/api/open', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const go = (p, o = {}) => fetch(base + p, { redirect: 'manual', ...o });
  const userCookie = `ct_user=${sessions.issue(5)}`;
  try { await fn(go, { userCookie, queries }); } finally { server.close(); }
}

(async () => {
  await check('no credential: 401 on every analytics API path, and the page redirects to sign-in', () => withApp('owner-key', async (go, { queries }) => {
    for (const p of PATHS) assert.strictEqual((await go(p)).status, 401, p);
    const page = await go('/admin/analytics', { headers: { accept: 'text/html' } });
    assert.strictEqual(page.status, 302);
    assert.strictEqual(page.headers.get('location'), '/login?next=%2Fadmin%2Fanalytics');
    assert.strictEqual(queries.length, 0, 'no query ran');
    assert.strictEqual((await go('/api/open')).status, 200, 'the rest of the app stays open');
  }));

  await check('a signed-in email user (not the owner) gets 403, page and API', () => withApp('owner-key', async (go, { userCookie, queries }) => {
    for (const p of PATHS) assert.strictEqual((await go(p, { headers: { cookie: userCookie } })).status, 403, p);
    const page = await go('/admin/analytics', { headers: { cookie: userCookie, accept: 'text/html' } });
    assert.strictEqual(page.status, 302, 'a browser is sent to the owner sign-in, not shown JSON');
    assert.strictEqual(page.headers.get('location'), '/login?next=%2Fadmin%2Fanalytics');
    assert.strictEqual(queries.length, 0);
  }));

  await check('an email user no longer passes the owner-only digest previews (403)', () => withApp('owner-key', async (go, { userCookie }) => {
    assert.strictEqual((await go('/digest/preview', { headers: { cookie: userCookie } })).status, 403);
  }));

  await check('the sign-in page asks for the owner key when an email user is sent to /admin', () => withApp('owner-key', async (go, { userCookie }) => {
    const r = await go('/login?next=%2Fadmin%2Fanalytics', { headers: { cookie: userCookie } });
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.match(html, /Owner sign-in/);
    assert.match(html, /name="password"[^>]*required autofocus/);
    assert.doesNotMatch(html, /name="email"/, 'only the owner key is asked');
    assert.match(html, /name="next" value="\/admin\/analytics"/);
  }));

  await check('owner sign-in: an empty key is refused on the page; the right key returns to the dashboard', () => withApp('owner-key', async (go) => {
    const form = (pw) => go('/login', { method: 'POST', body: new URLSearchParams({ password: pw, next: '/admin/analytics' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const empty = await form('');
    assert.strictEqual(empty.status, 400);
    assert.match(await empty.text(), /Enter the owner key/);
    const ok = await form('owner-key');
    assert.strictEqual(ok.status, 303);
    assert.strictEqual(ok.headers.get('location'), '/admin/analytics');
  }));

  await check('wrong owner key: 401', () => withApp('owner-key', async (go) => {
    assert.strictEqual((await go(PATHS[0], { headers: { authorization: basic('x:nope') } })).status, 401);
  }));

  await check('the owner (Basic or the signed-in owner cookie) gets the page, the data and CSV', () => withApp('owner-key', async (go) => {
    const auth = { authorization: basic('x:owner-key') };
    const page = await go('/admin/analytics', { headers: auth });
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /Product analytics/);
    assert.strictEqual(page.headers.get('cache-control'), 'no-store');
    const s = await go(PATHS[0], { headers: auth });
    assert.strictEqual(s.status, 200);
    const body = await s.json();
    assert.strictEqual(body.scope.range, '7d');
    assert.deepStrictEqual(body.retention.map((r) => r.day), [1, 7, 30]);
    const csv = await go('/api/admin/analytics/export.csv?kind=sessions&range=all', { headers: auth });
    assert.strictEqual(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(await csv.text(), /^session_id,user_id,/);
    assert.strictEqual((await go('/api/admin/analytics/export.csv?kind=nope', { headers: auth })).status, 400);

    const login = await go('/login', { method: 'POST', body: new URLSearchParams({ password: 'owner-key', next: '/admin/analytics' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.strictEqual(login.status, 303);
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    assert.strictEqual((await go('/api/admin/analytics/users', { headers: { cookie } })).status, 200);
  }));

  await check('marking the owner\'s browser internal: owner only, JSON only, a real device id; the signed-in email user goes with it', () => withApp('owner-key', async (go, { userCookie, queries }) => {
    const DEV = '0b9c3f3e-1d2a-4c5b-8e6f-123456789abc';
    const post = (headers, body) => go('/api/admin/analytics/internal', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.strictEqual((await post({}, { device_id: DEV })).status, 401);
    assert.strictEqual((await post({ cookie: userCookie }, { device_id: DEV })).status, 403, 'an email user cannot mark anyone');
    const auth = { authorization: basic('x:owner-key') };
    assert.strictEqual((await post(auth, { device_id: 'nope' })).status, 400);
    assert.strictEqual((await go('/api/admin/analytics/internal', { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    const ok = await post({ ...auth, cookie: userCookie }, { device_id: DEV });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(await ok.json(), { users: 1, sessions: 2 });
    assert.deepStrictEqual(queries.marks, [[DEV, 5]], 'device and the email user on that request');
  }));

  await check('no owner key configured: the dashboard is closed (403), not open', () => withApp('', async (go) => {
    assert.strictEqual((await go('/admin/analytics')).status, 403);
    for (const p of PATHS) assert.strictEqual((await go(p)).status, 403, p);
  }));

  await check('scope parsing and CSV cells', () => {
    const bogus = admin.parseScope({ range: 'bogus', user: '1; drop' });
    assert.strictEqual(bogus.range, '7d');
    assert.strictEqual(bogus.userId, null);
    assert.ok(Math.abs(Date.parse(bogus.since) - (Date.now() - 7 * 86400000)) < 5000);
    assert.strictEqual(admin.parseScope({ range: 'all' }).since, null);
    assert.strictEqual(admin.parseScope({ user: '42' }).userId, 42);
    assert.strictEqual(admin.rangeStart('today', new Date('2026-11-15T17:30:00Z')), '2026-11-15T00:00:00.000Z');
    assert.strictEqual(admin.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    assert.strictEqual(admin.csvCell({ a: 1 }), '"{""a"":1}"');
    assert.strictEqual(admin.csvCell(null), '');
  });

  if (failures) { console.error(`${failures} failed`); process.exit(1); }
})();
