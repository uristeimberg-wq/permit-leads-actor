// App users and saved permits (web/users.js): email normalising, the signed
// session cookie, body validation, and the /api/me routes over an in-memory
// store. Runs an in-process server on 127.0.0.1; no network, no database.
const assert = require('node:assert');
const express = require('express');
const { router, sessions, normalEmail, cleanSavedBody, COOKIE } = require('./users.js');

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`ok   - ${name}`); } catch (e) { failures += 1; console.error(`FAIL - ${name}`); console.error(e); }
};

/** The same contract as pgStore, in memory. Permit 1, 2 and 3 exist. */
function memoryStore() {
  const users = new Map(); const saved = new Map(); let seq = 0;
  const key = (u, p) => `${u}:${p}`;
  return {
    async findOrCreate(email) {
      for (const u of users.values()) if (u.email === email) return u;
      const u = { id: ++seq, email }; users.set(u.id, u); return u;
    },
    async get(id) { return users.get(id) || null; },
    async listSaved(userId) {
      return [...saved.values()].filter((s) => s.userId === userId)
        .map(({ permitId, status, note }) => ({ permitId, status, note }));
    },
    async upsertSaved(userId, permitId, { status, note }) {
      if (!['1', '2', '3'].includes(String(permitId))) return null;
      const k = key(userId, permitId);
      const cur = saved.get(k) || { userId, permitId: String(permitId), status: 'saved', note: null };
      const next = { ...cur, status: status || cur.status, note: note !== undefined ? note : cur.note };
      saved.set(k, next);
      return { permitId: next.permitId, status: next.status, note: next.note };
    },
    async removeSaved(userId, permitId) { saved.delete(key(userId, permitId)); },
    async countSaved(userId) { return (await this.listSaved(userId)).length; },
  };
}

async function withApp(fn) {
  const app = express();
  const permitsByIds = async (ids) => ids.map((id) => ({ id, address: `${id} MAIN ST` }));
  app.use(router({ store: memoryStore(), permitsByIds, sessions: sessions({ key: Buffer.alloc(32, 7) }) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const go = (p, o = {}) => fetch(base + p, { redirect: 'manual', ...o });
  const jsonReq = (method, body, cookie) => ({
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  });
  try { await fn(go, jsonReq); } finally { server.close(); }
}
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

(async () => {
  await check('emails are trimmed and lower-cased; junk is refused', () => {
    assert.strictEqual(normalEmail('  Dana@Example.COM '), 'dana@example.com');
    for (const bad of ['', 'dana', 'dana@', '@example.com', 'a b@example.com', 'dana@example', `${'x'.repeat(250)}@example.com`, '<a>@x.io']) {
      assert.strictEqual(normalEmail(bad), null, bad);
    }
  });

  await check('a session cookie proves its user, and nothing else does', () => {
    let t = 1_700_000_000_000;
    const s = sessions({ key: Buffer.alloc(32, 1), now: () => t });
    const req = (v) => ({ headers: { cookie: `${COOKIE}=${v}` } });
    const v = s.issue(42);
    assert.strictEqual(s.userId(req(v)), 42);
    assert.strictEqual(s.userId(req(v.replace(/\.42\./, '.43.'))), null, 'another user id with the same signature');
    assert.strictEqual(s.userId(req(`${v}x`)), null, 'a changed signature');
    assert.strictEqual(sessions({ key: Buffer.alloc(32, 2), now: () => t }).userId(req(v)), null, 'another key');
    assert.strictEqual(s.userId({ headers: {} }), null);
    t += 31 * 24 * 3600 * 1000;
    assert.strictEqual(s.userId(req(v)), null, 'expired after 30 days');
  });

  await check('saved-permit bodies: known statuses only, notes trimmed and capped', () => {
    assert.deepStrictEqual(cleanSavedBody({}), {});
    assert.deepStrictEqual(cleanSavedBody({ status: 'called', note: '  call   back  ' }), { status: 'called', note: 'call back' });
    assert.deepStrictEqual(cleanSavedBody({ note: '' }), { note: null });
    assert.ok(cleanSavedBody({ status: 'maybe' }).error);
    assert.ok(cleanSavedBody({ note: 'x'.repeat(501) }).error);
  });

  await check('signed out: /api/me is empty and the saved list asks to sign in', () => withApp(async (go) => {
    assert.deepStrictEqual(await (await go('/api/me')).json(), { email: null, saved: [] });
    const r = await go('/api/me/saved');
    assert.strictEqual(r.status, 401);
    assert.strictEqual((await r.json()).signIn, true);
  }));

  await check('sign-in takes JSON only (no cross-site form posts) and a valid email', () => withApp(async (go, jsonReq) => {
    const form = await go('/api/me/signin', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a%40b.co' });
    assert.strictEqual(form.status, 415);
    assert.strictEqual((await go('/api/me/signin', jsonReq('POST', { email: 'nope' }))).status, 400);
    const ok = await go('/api/me/signin', jsonReq('POST', { email: ' Dana@Example.com ' }));
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(await ok.json(), { email: 'dana@example.com' });
    const set = ok.headers.get('set-cookie');
    assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Lax/);
  }));

  await check('save, set a status and note, list, remove; each user sees only their own', () => withApp(async (go, jsonReq) => {
    const a = cookieOf(await go('/api/me/signin', jsonReq('POST', { email: 'a@example.com' })));
    const b = cookieOf(await go('/api/me/signin', jsonReq('POST', { email: 'b@example.com' })));
    assert.strictEqual((await go('/api/me/saved/2', jsonReq('PUT', {}, a))).status, 200);
    const upd = await (await go('/api/me/saved/2', jsonReq('PUT', { status: 'called', note: 'spoke to Dana' }, a))).json();
    assert.deepStrictEqual([upd.status, upd.note], ['called', 'spoke to Dana']);
    // A status change alone keeps the note.
    const kept = await (await go('/api/me/saved/2', jsonReq('PUT', { status: 'quoted' }, a))).json();
    assert.strictEqual(kept.note, 'spoke to Dana');
    assert.strictEqual((await go('/api/me/saved/2', jsonReq('PUT', { status: 'maybe' }, a))).status, 400);
    assert.strictEqual((await go('/api/me/saved/99', jsonReq('PUT', {}, a))).status, 404, 'a permit we do not hold');
    assert.strictEqual((await go('/api/me/saved/abc', jsonReq('PUT', {}, a))).status, 400);

    const list = await (await go('/api/me/saved', { headers: { cookie: a } })).json();
    assert.strictEqual(list.items.length, 1);
    assert.strictEqual(list.items[0].permit.address, '2 MAIN ST');
    assert.deepStrictEqual(await (await go('/api/me', { headers: { cookie: b } })).json(), { email: 'b@example.com', saved: [] });

    assert.strictEqual((await go('/api/me/saved/2', { method: 'DELETE', headers: { cookie: a } })).status, 200);
    assert.deepStrictEqual((await (await go('/api/me', { headers: { cookie: a } })).json()).saved, []);
  }));

  await check('writes without a session are refused', () => withApp(async (go, jsonReq) => {
    assert.strictEqual((await go('/api/me/saved/2', jsonReq('PUT', {}))).status, 401);
    assert.strictEqual((await go('/api/me/saved/2', { method: 'DELETE' })).status, 401);
  }));

  await check('/logout clears the session cookie', () => withApp(async (go) => {
    const r = await go('/logout');
    assert.strictEqual(r.status, 303);
    assert.match(r.headers.get('set-cookie'), new RegExp(`${COOKIE}=;`));
  }));

  if (failures) process.exitCode = 1;
  else console.log('users.test.js: all passed');
})();
