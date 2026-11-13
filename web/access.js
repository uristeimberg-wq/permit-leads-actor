// Access gate for a hosted demo (ADR-13). When DEMO_PASSWORD is set, every
// request needs either a session cookie from the sign-in page or HTTP Basic
// auth with that password (any user name). Unset, the app is open, which is
// right for localhost only.
//
// Browsers get a branded sign-in page at /login instead of the native Basic
// auth popup: a page request without a session is redirected there, an API
// request gets 401 JSON. Basic auth stays for scripts (the smoke check) but is
// never asked for, so no popup appears.
//
// The session cookie is `<expiry>.<hmac>`, signed with a key derived from the
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

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loginPage({ next = '/', error = '' } = {}) {
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
main { display: grid; place-items: center; padding: 40px 16px; }
.plate { width: min(100%, 440px); background: var(--color-plate); border: 3px solid var(--color-ink); box-shadow: var(--shadow-plate); padding: 32px 32px 28px; }
h1 { margin: 0; font: 700 2.25rem/1.02 var(--font-display); text-transform: uppercase; text-wrap: balance; }
p { margin: 12px 0 0; color: var(--color-ink-2); text-wrap: pretty; }
form { margin-top: 24px; display: flex; flex-direction: column; gap: 8px; }
label { font-size: 13px; color: var(--color-muted); }
input { font: 400 16px/1.2 var(--font-body); min-height: 44px; padding: 0 12px; border: 2px solid var(--color-ink); border-radius: 0; background: var(--color-plate); color: var(--color-ink); }
input:focus-visible, button:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
button { margin-top: 12px; min-height: 44px; border: 0; border-radius: 0; cursor: pointer; background: var(--color-accent); color: var(--color-accent-ink); box-shadow: 0 3px 0 var(--color-accent-deep); font: 700 15px/1 var(--font-display); text-transform: uppercase; letter-spacing: 0.02em; transition: translate 120ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 120ms cubic-bezier(0.22, 1, 0.36, 1), background-color 120ms cubic-bezier(0.22, 1, 0.36, 1); }
button:hover { background: var(--color-accent-deep); }
button:active { translate: 0 3px; box-shadow: 0 0 0 var(--color-accent-deep); }
.err { margin: 16px 0 0; padding: 8px 12px; background: var(--color-err-wash); color: var(--color-err); border-left: 3px solid var(--color-err); font-size: 14px; }
footer { font-size: 12px; color: var(--color-muted); }
footer div { padding-top: 16px; padding-bottom: 16px; border-top: 1px solid oklch(84% 0.012 85); }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
</head>
<body>
<header><div><span class="wordmark"><i aria-hidden="true"></i>Contractos</span></div></header>
<main>
  <section class="plate" aria-labelledby="t">
    <h1 id="t">Permit leads, pilot demo</h1>
    <p>Every new building job in Austin and Miami-Dade, with the contractor who pulled it. Enter the demo password to continue.</p>
    ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${esc(next)}">
      <label for="pw">Password</label>
      <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Sign in</button>
    </form>
  </section>
</main>
<footer><div>Built on public permit records. Individuals' names and contacts are withheld.</div></footer>
</body>
</html>`;
}

/**
 * The gate, as a router to mount before everything it protects.
 * @param {string} password DEMO_PASSWORD; empty means open
 * @param {{now?: () => number}} [opts] clock override for tests
 */
function demoGate(password = process.env.DEMO_PASSWORD, opts = {}) {
  const router = express.Router();
  if (!password) return router;
  const now = opts.now || Date.now;
  const want = sha(password);
  const key = crypto.createHmac('sha256', 'contractos-demo-session').update(password).digest();
  const sign = (exp) => crypto.createHmac('sha256', key).update(String(exp)).digest('base64url');
  const fails = new Map(); // ip -> { n, since }

  const validSession = (req) => {
    const v = readCookie(req.headers.cookie, COOKIE);
    const m = /^(\d{10,16})\.([\w-]{20,})$/.exec(v || '');
    if (!m || Number(m[1]) < now()) return false;
    return same(Buffer.from(m[2]), Buffer.from(sign(m[1])));
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

  router.get('/login', (req, res) => {
    if (validSession(req)) return res.redirect(303, safeNext(req.query.next));
    return html(res, 200, loginPage({ next: safeNext(req.query.next) }));
  });

  router.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    const ip = req.ip || 'unknown';
    const next = safeNext(req.body && req.body.next);
    if (limited(ip)) {
      res.set('Retry-After', String(Math.ceil(FAIL_WINDOW_MS / 1000)));
      return html(res, 429, loginPage({ next, error: 'Too many attempts. Wait 15 minutes, then try again.' }));
    }
    if (!same(sha((req.body && req.body.password) || ''), want)) {
      noteFail(ip);
      return html(res, 401, loginPage({ next, error: 'That password didn’t work.' }));
    }
    fails.delete(ip);
    const exp = now() + SESSION_MS;
    res.cookie(COOKIE, `${exp}.${sign(exp)}`, {
      httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: SESSION_MS,
    });
    return res.redirect(303, next);
  });

  router.get('/logout', (req, res) => {
    res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
    return res.redirect(303, '/login');
  });

  router.use((req, res, next) => {
    if (validSession(req) || validBasic(req)) return next();
    const wantsPage = (req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api/')
      && /text\/html|\*\/\*/.test(String(req.headers.accept || '*/*'));
    if (wantsPage) return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    return res.status(401).set('Cache-Control', 'no-store').json({ error: 'Sign in required' });
  });

  return router;
}

module.exports = { demoGate, safeNext, loginPage, COOKIE };
