// The demo gate: sign-in page, session cookie, Basic auth for scripts, rate
// limit. Runs an in-process server on 127.0.0.1; no network, no database.
const assert = require('node:assert');
const express = require('express');
const { demoGate, safeNext } = require('./access.js');

const basic = (s) => `Basic ${Buffer.from(s).toString('base64')}`;
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`ok   - ${name}`); } catch (e) { failures += 1; console.error(`FAIL - ${name}`); console.error(e); }
};

async function withApp(password, fn, opts) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(demoGate(password, opts));
  app.get('/page', (_req, res) => res.type('html').send('<p>in</p>'));
  app.get('/api/x', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const go = (p, o = {}) => fetch(base + p, { redirect: 'manual', ...o });
  try { await fn(go); } finally { server.close(); }
}
const login = (go, pw, next = '/page', ip = '10.0.0.1') => go('/login', {
  method: 'POST', body: new URLSearchParams({ password: pw, next }),
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
});
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

(async () => {
  await check('no password configured: open', () => withApp('', async (go) => {
    assert.strictEqual((await go('/page')).status, 200);
  }));

  await check('a page without a session redirects to the sign-in page, never a Basic popup', () => withApp('s3cret', async (go) => {
    const r = await go('/page?x=1', { headers: { accept: 'text/html' } });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), '/login?next=%2Fpage%3Fx%3D1');
    assert.strictEqual(r.headers.get('www-authenticate'), null);
    const page = await go('/login');
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /name="password"/);
  }));

  await check('an API call without a session is 401 JSON', () => withApp('s3cret', async (go) => {
    const r = await go('/api/x');
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.headers.get('www-authenticate'), null);
    assert.deepStrictEqual(await r.json(), { error: 'Sign in required' });
  }));

  await check('right password sets an HttpOnly SameSite cookie that opens pages and the API', () => withApp('s3cret', async (go) => {
    const r = await login(go, 's3cret');
    assert.strictEqual(r.status, 303);
    assert.strictEqual(r.headers.get('location'), '/page');
    const set = r.headers.get('set-cookie');
    assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Lax/);
    const cookie = cookieOf(r);
    assert.strictEqual((await go('/page', { headers: { cookie } })).status, 200);
    assert.strictEqual((await go('/api/x', { headers: { cookie } })).status, 200);
  }));

  await check('Secure flag when the proxy says HTTPS', () => withApp('s3cret', async (go) => {
    const r = await go('/login', { method: 'POST', body: 'password=s3cret',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' } });
    assert.match(r.headers.get('set-cookie'), /Secure/);
  }));

  await check('wrong password: 401 page, no cookie', () => withApp('s3cret', async (go) => {
    const r = await login(go, 'nope');
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.headers.get('set-cookie'), null);
    assert.match(await r.text(), /didn’t work/);
  }));

  await check('a forged, tampered or expired cookie is refused', () => {
    let t = 1_800_000_000_000;
    return withApp('s3cret', async (go) => {
      const good = cookieOf(await login(go, 's3cret'));
      const tampered = good.replace(/=(\d+)\./, (_m, d) => `=${Number(d) + 1}.`);
      assert.strictEqual((await go('/api/x', { headers: { cookie: tampered } })).status, 401);
      assert.strictEqual((await go('/api/x', { headers: { cookie: 'demo_session=99999999999999.abcdefghijklmnopqrstuvwxyz' } })).status, 401);
      t += 8 * 24 * 3600 * 1000;
      assert.strictEqual((await go('/api/x', { headers: { cookie: good } })).status, 401);
    }, { now: () => t });
  });

  await check('a cookie from another password is refused', async () => {
    let cookie;
    await withApp('old-pass', async (go) => { cookie = cookieOf(await login(go, 'old-pass')); });
    await withApp('new-pass', async (go) => { assert.strictEqual((await go('/api/x', { headers: { cookie } })).status, 401); });
  });

  await check('Basic auth still works for scripts, any user name, colons in the password', () => withApp('a:b', async (go) => {
    assert.strictEqual((await go('/api/x', { headers: { authorization: basic('smoke:a:b') } })).status, 200);
    assert.strictEqual((await go('/api/x', { headers: { authorization: basic('smoke:nope') } })).status, 401);
  }));

  await check('sign-in is rate limited per IP after 8 failures', () => withApp('s3cret', async (go) => {
    for (let i = 0; i < 8; i += 1) assert.strictEqual((await login(go, 'nope', '/', '10.9.9.9')).status, 401);
    const blocked = await login(go, 's3cret', '/', '10.9.9.9');
    assert.strictEqual(blocked.status, 429);
    assert.strictEqual(blocked.headers.get('set-cookie'), null);
    assert.strictEqual((await login(go, 's3cret', '/', '10.1.1.1')).status, 303);
  }));

  await check('next is limited to same-site paths', () => {
    assert.strictEqual(safeNext('/pilot/live/?source=x'), '/pilot/live/?source=x');
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', '', '/login?next=/x']) assert.strictEqual(safeNext(bad), '/');
  });

  await check('logout clears the cookie', () => withApp('s3cret', async (go) => {
    const r = await go('/logout');
    assert.strictEqual(r.status, 303);
    assert.match(r.headers.get('set-cookie'), /demo_session=;/);
  }));

  if (failures) process.exitCode = 1;
})();
