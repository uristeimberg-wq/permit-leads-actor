// Access gate for the hosted app (ADR-13, ADR-27). When DEMO_PASSWORD is set,
// every request needs either a session cookie from the sign-in page or HTTP
// Basic auth with that password (any user name). Unset, the app is open, which
// is right for localhost only.
//
// Access is invite-only: each person signs in with their own code
// (web/invites.js, `npm run invite`); DEMO_PASSWORD is the owner's key. The
// sign-in page asks, optionally, which industry the person works in, so we
// learn who uses the data without steering anyone into one workflow. A
// revoked code stops working within a minute, sessions included.
//
// Browsers get a branded sign-in page at /login instead of the native Basic
// auth popup: a page request without a session is redirected there, an API
// request gets 401 JSON. Basic auth stays for scripts (the smoke check) but is
// never asked for, so no popup appears.
//
// The session cookie is `<expiry>.<invite id>.<hmac>` (invite 0 = the owner), signed with a key derived from the
// password, so changing DEMO_PASSWORD signs everyone out. It is HttpOnly,
// SameSite=Lax and Secure on HTTPS. Failed sign-ins are rate limited per IP.
// Every comparison is constant-time.

const crypto = require('node:crypto');
const express = require('express');

const COOKIE = 'demo_session';
const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_FAILS = 8;               // per IP per window
const FAIL_WINDOW_MS = 15 * 60 * 1000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Only same-site paths survive as a post-login destination (no open redirect). */
function safeNext(v) {
  const s = String(v || '');
  return /^\/(?![/\\])[^\s]*$/.test(s) && !s.startsWith('/login') ? s : '/';
}

const { INDUSTRIES, cleanIndustry } = require('./invites.js');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loginPage({ next = '/', error = '', invites = false, email = false } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in · Contractos</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;700&amp;family=Oswald:wght@700&amp;display=swap" rel="stylesheet">
<style>
/* Hallmark · sign-in, on the pilot tokens (web/public/pilot/live/live.css). Inline because nothing static is served before sign-in. */
:root {
  --color-paper: oklch(96.4% 0.009 85); --color-paper-2: oklch(93.2% 0.011 85); --color-plate: oklch(98.6% 0.005 85);
  --color-ink: oklch(22% 0.02 260); --color-ink-2: oklch(31% 0.018 260); --color-muted: oklch(44% 0.014 260);
  --color-accent: oklch(52% 0.15 48); --color-accent-deep: oklch(40% 0.12 48); --color-accent-ink: oklch(98.6% 0.005 85);
  --color-focus: oklch(50% 0.17 48); --color-err: oklch(46% 0.16 25); --color-err-wash: oklch(94% 0.03 25);
  --font-display: "Oswald", "Arial Narrow", ui-sans-serif, sans-serif; --font-body: "Archivo", ui-sans-serif, system-ui, sans-serif;
  --shadow-plate: 6px 6px 0 var(--color-ink);
}
*, *::before, *::after { box-sizing: border-box; }
html, body { overflow-x: clip; }
body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; grid-template-rows: auto 1fr auto; background: var(--color-paper); color: var(--color-ink); font: 400 15px/1.5 var(--font-body); font-synthesis: none; -webkit-font-smoothing: antialiased; }
header { background: var(--color-ink); }
header div, footer div { max-width: 1320px; margin: 0 auto; padding: 0 16px; }
header div { min-height: 52px; display: flex; align-items: center; }
.wordmark { display: flex; align-items: center; gap: 8px; font: 700 20px/1 var(--font-display); text-transform: uppercase; color: var(--color-plate); letter-spacing: 0.01em; }
.wordmark i { display: inline-block; width: 12px; height: 12px; background: var(--color-accent); }
main { display: grid; grid-template-columns: minmax(0, 1fr); place-items: center; padding: 40px 16px; }
.plate { min-width: 0; }
h1 { overflow-wrap: anywhere; }
.plate { width: min(100%, 440px); background: var(--color-plate); border: 3px solid var(--color-ink); box-shadow: var(--shadow-plate); padding: 32px 32px 28px; }
h1 { margin: 0; font: 700 2.25rem/1.02 var(--font-display); text-transform: uppercase; text-wrap: balance; }
p { margin: 12px 0 0; color: var(--color-ink-2); text-wrap: pretty; }
form { margin-top: 24px; display: flex; flex-direction: column; gap: 8px; }
label { font-size: 13px; color: var(--color-muted); }
input, select { font: 400 16px/1.2 var(--font-body); min-height: 44px; padding: 0 12px; border: 2px solid var(--color-ink); border-radius: 0; background: var(--color-plate); color: var(--color-ink); }
input:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
button { margin-top: 12px; min-height: 44px; border: 0; border-radius: 0; cursor: pointer; background: var(--color-accent); color: var(--color-accent-ink); box-shadow: 0 3px 0 var(--color-accent-deep); font: 700 15px/1 var(--font-display); text-transform: uppercase; letter-spacing: 0.02em; transition: translate 120ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 120ms cubic-bezier(0.22, 1, 0.36, 1), background-color 120ms cubic-bezier(0.22, 1, 0.36, 1); }
button:hover { background: var(--color-accent-deep); }
button:active { translate: 0 3px; box-shadow: 0 0 0 var(--color-accent-deep); }
details.owner { margin-top: 8px; font-size: 13px; color: var(--color-muted); }
details.owner summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; }
details.owner summary::before { content: '▸'; margin-right: 6px; }
details.owner[open] summary::before { content: '▾'; }
details.owner[open] { display: flex; flex-direction: column; gap: 8px; }
.err { margin: 16px 0 0; padding: 8px 12px; background: var(--color-err-wash); color: var(--color-err); border-left: 3px solid var(--color-err); font-size: 14px; }
footer { font-size: 12px; color: var(--color-muted); }
footer div { padding-top: 16px; padding-bottom: 16px; border-top: 1px solid oklch(84% 0.012 85); }
@media (max-width: 400px) { .plate { padding: 24px 20px 20px; } h1 { font-size: 1.875rem; } }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
</head>
<body>
<header><div><span class="wordmark"><i aria-hidden="true"></i>Contractos</span></div></header>
<main>
  <section class="plate" aria-labelledby="t">
    <h1 id="t">Construction permit data</h1>
    <p>Permit, planning and property records from public sources, with the source behind every value. ${email ? 'Sign in with your email to see leads and keep your saved permits.' : invites ? 'Access is by invitation: enter the code you were given.' : 'Enter the password to continue.'}</p>
    ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${esc(next)}">
      ${email ? `<label for="em">Email</label>
      <input id="em" name="email" type="email" autocomplete="email" inputmode="email" maxlength="254" autofocus>
      <details class="owner"><summary>Owner key</summary>
        <label for="pw">Owner key</label>
        <input id="pw" name="password" type="password" autocomplete="current-password">
      </details>` : `<label for="pw">${invites ? 'Access code' : 'Password'}</label>
      <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>`}
      ${invites ? `<label for="ind">Your industry (optional)</label>
      <select id="ind" name="industry">${Object.entries(INDUSTRIES).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}</select>
      <label for="ind-o">If other, which (optional)</label>
      <input id="ind-o" name="industryOther" maxlength="80" autocomplete="organization-title">` : ''}
      <button type="submit">Sign in</button>
    </form>
  </section>
</main>
<footer><div>Built on public records. Individuals' names and contacts are withheld. ${email ? 'Your email only keeps your saved permits; we do not check it or send you mail.' : 'Your industry only tells us who uses the data; it does not change what you see.'}</div></footer>
</body>
</html>`;
}

/**
 * The gate, as a router to mount before everything it protects.
 * @param {string} password DEMO_PASSWORD; empty means open
 * @param {{now?: () => number, invites?: {find, isLive, record},
 *          users?: {store: {findOrCreate}, sessions: object, normalEmail: Function}}} [opts]
 *   clock override for tests; the invite store (web/invites.js pgStore); or
 *   email sign-in (web/users.js), which replaces invite codes: the page asks
 *   for an email, and a signed `ct_user` cookie is a session. DEMO_PASSWORD
 *   still signs in as the owner ("Owner key").
 *   `isPublic(req)`: requests it returns true for pass without sign-in (open
 *   access); the rest, such as the digest previews, still need the owner key.
 */
function demoGate(password = process.env.DEMO_PASSWORD, opts = {}) {
  const router = express.Router();
  if (!password) return router;
  const now = opts.now || Date.now;
  const users = opts.users || null;
  const store = users ? null : (opts.invites || null);
  const page = (o) => loginPage({ ...o, invites: Boolean(store), email: Boolean(users) });
  const live = new Map(); // invite id -> { ok, at }, so a revoked code stops within a minute
  const inviteLive = async (id) => {
    if (id === 0) return true;
    if (!store) return false;
    const c = live.get(id);
    if (c && now() - c.at < 60000) return c.ok;
    const ok = await store.isLive(id).catch((e) => { console.error(`invite check failed: ${e.message}`); return false; });
    live.set(id, { ok, at: now() });
    if (live.size > 10000) live.clear();
    return ok;
  };
  const want = sha(password);
  const key = crypto.createHmac('sha256', 'contractos-demo-session').update(password).digest();
  const sign = (exp) => crypto.createHmac('sha256', key).update(String(exp)).digest('base64url');
  const fails = new Map(); // ip -> { n, since }

  const validSession = async (req) => {
    if (users && users.sessions.userId(req)) return true;
    const v = readCookie(req.headers.cookie, COOKIE);
    const m = /^(\d{10,16})\.(\d{1,18})\.([\w-]{20,})$/.exec(v || '');
    if (!m || Number(m[1]) < now()) return false;
    if (!same(Buffer.from(m[3]), Buffer.from(sign(`${m[1]}.${m[2]}`)))) return false;
    return inviteLive(Number(m[2]));
  };
  const validBasic = (req) => {
    const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
    if (scheme !== 'Basic' || !encoded) return false;
    const given = Buffer.from(encoded, 'base64').toString('utf8');
    return same(sha(given.slice(given.indexOf(':') + 1)), want);
  };
  const limited = (ip) => {
    const f = fails.get(ip);
    if (!f) return false;
    if (now() - f.since > FAIL_WINDOW_MS) { fails.delete(ip); return false; }
    return f.n >= MAX_FAILS;
  };
  const noteFail = (ip) => {
    const f = fails.get(ip);
    if (!f || now() - f.since > FAIL_WINDOW_MS) fails.set(ip, { n: 1, since: now() });
    else f.n += 1;
    if (fails.size > 10000) fails.clear(); // bound memory under a spray
  };
  const html = (res, status, body) => res.status(status).set('Cache-Control', 'no-store').type('html').send(body);

  router.get('/login', async (req, res) => {
    if (await validSession(req)) return res.redirect(303, safeNext(req.query.next));
    return html(res, 200, page({ next: safeNext(req.query.next) }));
  });

  router.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
    const ip = req.ip || 'unknown';
    const next = safeNext(req.body && req.body.next);
    if (limited(ip)) {
      res.set('Retry-After', String(Math.ceil(FAIL_WINDOW_MS / 1000)));
      return html(res, 429, page({ next, error: 'Too many attempts. Wait 15 minutes, then try again.' }));
    }
    const given = (req.body && req.body.password) || '';
    // Email sign-in (no verification, by owner decision): any well-formed
    // address is a user. The owner key, when typed, takes precedence.
    if (users && !given) {
      const email = users.normalEmail(req.body && req.body.email);
      if (!email) {
        noteFail(ip);
        return html(res, 400, page({ next, error: 'Enter a valid email address.' }));
      }
      const user = await users.store.findOrCreate(email).catch((e) => { console.error(`sign-in failed: ${e.message}`); return null; });
      if (!user) return html(res, 503, page({ next, error: 'Sign-in is unavailable right now. Try again in a minute.' }));
      fails.delete(ip);
      users.sessions.set(res, req, user.id);
      return res.redirect(303, next);
    }
    let inviteId = same(sha(given), want) ? 0 : null;
    if (inviteId == null && store) {
      const inv = await store.find(given).catch((e) => { console.error(`invite lookup failed: ${e.message}`); return null; });
      if (inv) inviteId = inv.id;
    }
    if (inviteId == null) {
      noteFail(ip);
      return html(res, 401, page({ next, error: users ? 'That owner key didn’t work.' : store ? 'That code didn’t work.' : 'That password didn’t work.' }));
    }
    fails.delete(ip);
    live.set(inviteId, { ok: true, at: now() });
    if (store) {
      // A failed record never blocks sign-in, but it is logged (rule 3).
      await store.record({ inviteId: inviteId || null, ...cleanIndustry(req.body) })
        .catch((e) => console.error(`sign-in record failed: ${e.message}`));
    }
    const exp = now() + SESSION_MS;
    res.cookie(COOKIE, `${exp}.${inviteId}.${sign(`${exp}.${inviteId}`)}`, {
      httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: SESSION_MS,
    });
    return res.redirect(303, next);
  });

  router.get('/logout', (req, res) => {
    res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
    if (users) users.sessions.clear(res, req);
    return res.redirect(303, opts.isPublic ? '/' : '/login');
  });

  router.use(async (req, res, next) => {
    // Open access (owner decision 2026-11-15): everything but the owner-only
    // paths is public, so no sign-in is asked. isPublic decides per request.
    if (opts.isPublic && opts.isPublic(req)) return next();
    if (validBasic(req) || await validSession(req)) return next();
    const wantsPage = (req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api/')
      && /text\/html|\*\/\*/.test(String(req.headers.accept || '*/*'));
    if (wantsPage) return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    return res.status(401).set('Cache-Control', 'no-store').json({ error: 'Sign in required' });
  });

  return router;
}

module.exports = { demoGate, safeNext, loginPage, COOKIE };
