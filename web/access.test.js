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

  // Invite-only access (ADR-27), over an in-memory store.
  const memStore = () => {
    const invites = new Map([['ABCD-EFGH-JK23', { id: 7, revoked: false }]]);
    const signins = [];
    return {
      invites, signins,
      find: async (code) => { const i = invites.get(String(code).trim().toUpperCase()); return i && !i.revoked ? { id: i.id } : null; },
      isLive: async (id) => [...invites.values()].some((i) => i.id === id && !i.revoked),
      record: async (r) => { signins.push(r); },
    };
  };
  const signIn = (go, body, ip = '10.0.0.9') => go('/login', {
    method: 'POST', body: new URLSearchParams({ next: '/page', ...body }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
  });

  await check('invites: the page asks for an access code and an optional industry', async () => {
    const st = memStore();
    await withApp('s3cret', async (go) => {
      const html = await (await go('/login')).text();
      assert.match(html, /Access code/);
      assert.match(html, /name="industry"/);
      assert.match(html, /Insurance/);
      assert.ok(!/lead/i.test(html), 'no lead language');
    }, { invites: st });
  });

  await check('invites: a live code signs in and records the industry; nothing else is recorded', async () => {
    const st = memStore();
    await withApp('s3cret', async (go) => {
      const r = await signIn(go, { password: 'abcd-efgh-jk23', industry: 'insurance', industryOther: 'ignored' });
      assert.strictEqual(r.status, 303);
      const cookie = cookieOf(r);
      assert.match(cookie, /^demo_session=\d+\.7\./);
      assert.strictEqual((await go('/page', { headers: { cookie } })).status, 200);
      assert.deepStrictEqual(st.signins, [{ inviteId: 7, industry: 'insurance', industryOther: null }]);
    }, { invites: st });
  });

  await check('invites: industry is optional, "other" keeps short free text, unknown values become null', async () => {
    const st = memStore();
    await withApp('s3cret', async (go) => {
      await signIn(go, { password: 'ABCD-EFGH-JK23' });
      await signIn(go, { password: 'ABCD-EFGH-JK23', industry: 'other', industryOther: '  solar   installer ' });
      await signIn(go, { password: 'ABCD-EFGH-JK23', industry: 'hacker<script>' });
      assert.deepStrictEqual(st.signins.map((x) => [x.industry, x.industryOther]), [[null, null], ['other', 'solar installer'], [null, null]]);
    }, { invites: st });
  });

  await check('invites: a wrong or revoked code is refused, and revoking ends an open session', async () => {
    let t = 1_800_000_000_000;
    const st = memStore();
    await withApp('s3cret', async (go) => {
      assert.strictEqual((await signIn(go, { password: 'ZZZZ-ZZZZ-ZZZZ' })).status, 401);
      const cookie = cookieOf(await signIn(go, { password: 'ABCD-EFGH-JK23' }));
      assert.strictEqual((await go('/api/x', { headers: { cookie } })).status, 200);
      st.invites.get('ABCD-EFGH-JK23').revoked = true;
      t += 61_000; // past the one-minute cache
      assert.strictEqual((await go('/api/x', { headers: { cookie } })).status, 401);
      assert.strictEqual((await signIn(go, { password: 'ABCD-EFGH-JK23' })).status, 401);
    }, { invites: st, now: () => t });
  });

  await check('invites: the owner password still signs in, recorded without an invite', async () => {
    const st = memStore();
    await withApp('s3cret', async (go) => {
      const r = await signIn(go, { password: 's3cret', industry: 'builder' });
      assert.strictEqual(r.status, 303);
      assert.match(cookieOf(r), /^demo_session=\d+\.0\./);
      assert.deepStrictEqual(st.signins, [{ inviteId: null, industry: 'builder', industryOther: null }]);
    }, { invites: st });
  });

  await check('invites: a store failure refuses the code but never crashes', async () => {
    const st = { find: async () => { throw new Error('db down'); }, isLive: async () => false, record: async () => {} };
    const err = console.error; console.error = () => {};
    try {
      await withApp('s3cret', async (go) => {
        assert.strictEqual((await signIn(go, { password: 'ABCD-EFGH-JK23' })).status, 401);
        assert.strictEqual((await signIn(go, { password: 's3cret' })).status, 303);
      }, { invites: st });
    } finally { console.error = err; }
  });

  if (failures) process.exitCode = 1;
})();
