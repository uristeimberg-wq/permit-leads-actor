// App users and their saved permits (the Leads screen's heart button).
//
// A user is an email address. Sign-in is email only, with no verification: an
// owner decision for the pilot (2026-11-15). Anyone who types an address can
// read and change that address's saved list, so nothing sensitive is stored.
//
// The session is a signed cookie `ct_user` = `<expiry>.<userId>.<hmac>`,
// HttpOnly, SameSite=Lax, Secure on HTTPS. The key comes from SESSION_SECRET,
// else DEMO_PASSWORD, else a fixed development key (logged once): changing the
// key signs everyone out. Comparisons are constant-time.
//
// Writes accept JSON only, so a cross-site form cannot post here (SameSite=Lax
// already keeps the cookie off cross-site POSTs; this is the second lock).
// Permits come back through db/queries.js permitsByIds, the same redaction as
// the search (rule 5).

const crypto = require('node:crypto');
const express = require('express');

const COOKIE = 'ct_user';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const STATUSES = ['saved', 'called', 'no_answer', 'quoted', 'won', 'lost', 'not_relevant'];
const MAX_NOTE = 500;
const MAX_SAVED = 1000;   // per user; far beyond a pilot, keeps one list bounded

let warned = false;
function sessionKey(env = process.env) {
  const secret = env.SESSION_SECRET || env.DEMO_PASSWORD;
  if (!secret && !warned) {
    warned = true;
    console.warn('users: SESSION_SECRET is not set; signing sessions with a development key. Set it on any shared host.');
  }
  return crypto.createHmac('sha256', 'contractos-user-session').update(secret || 'contractos-dev-only').digest();
}

/** A plausible address, lower-cased, or null. Deliberately simple: no check is done that it exists. */
function normalEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  return s.length <= 254 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/.test(s) ? s : null;
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function sessions({ key = sessionKey(), now = Date.now } = {}) {
  const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return {
    /** The cookie value for a user. */
    issue(userId) {
      const exp = now() + SESSION_MS;
      return `${exp}.${userId}.${sign(`${exp}.${userId}`)}`;
    },
    /** The user id a request's cookie proves, or null. */
    userId(req) {
      const v = readCookie(req.headers && req.headers.cookie, COOKIE);
      const m = /^(\d{10,16})\.(\d{1,18})\.([\w-]{20,})$/.exec(v || '');
      if (!m || Number(m[1]) < now()) return null;
      const want = Buffer.from(sign(`${m[1]}.${m[2]}`));
      const got = Buffer.from(m[3]);
      return got.length === want.length && crypto.timingSafeEqual(got, want) ? Number(m[2]) : null;
    },
    set(res, req, userId) {
      res.cookie(COOKIE, this.issue(userId), { httpOnly: true, sameSite: 'lax', secure: Boolean(req.secure), path: '/', maxAge: SESSION_MS });
    },
    clear(res, req) {
      res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: Boolean(req.secure), path: '/' });
    },
  };
}

/** The store over Postgres. `query` is db/index.js query. */
function pgStore(query) {
  return {
    async findOrCreate(email) {
      const { rows: [r] } = await query(`
        INSERT INTO app_users (email, last_seen_at) VALUES ($1, now())
        ON CONFLICT (email) DO UPDATE SET last_seen_at = now()
        RETURNING id, email`, [email]);
      return { id: Number(r.id), email: r.email };
    },
    async get(id) {
      const { rows: [r] } = await query('SELECT id, email FROM app_users WHERE id = $1', [id]);
      return r ? { id: Number(r.id), email: r.email } : null;
    },
    async listSaved(userId) {
      const { rows } = await query(`
        SELECT permit_id, status, note, created_at, updated_at FROM saved_permits
         WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`, [userId, MAX_SAVED]);
      return rows.map((r) => ({ permitId: String(r.permit_id), status: r.status, note: r.note, savedAt: r.created_at, updatedAt: r.updated_at }));
    },
    async upsertSaved(userId, permitId, { status, note }) {
      const { rows: [r] } = await query(`
        INSERT INTO saved_permits (user_id, permit_id, status, note)
        SELECT $1, p.id, coalesce($3, 'saved'), $4 FROM permits p WHERE p.id = $2
        ON CONFLICT (user_id, permit_id) DO UPDATE SET
          status = coalesce($3, saved_permits.status),
          note = CASE WHEN $5 THEN $4 ELSE saved_permits.note END,
          updated_at = now()
        RETURNING permit_id, status, note, created_at, updated_at`,
      [userId, permitId, status, note, note !== undefined]);
      return r ? { permitId: String(r.permit_id), status: r.status, note: r.note, savedAt: r.created_at, updatedAt: r.updated_at } : null;
    },
    async removeSaved(userId, permitId) {
      await query('DELETE FROM saved_permits WHERE user_id = $1 AND permit_id = $2', [userId, permitId]);
    },
    async countSaved(userId) {
      const { rows: [r] } = await query('SELECT count(*)::int AS n FROM saved_permits WHERE user_id = $1', [userId]);
      return r.n;
    },
  };
}

/** Body fields for a saved permit, validated: undefined means "leave as is". */
function cleanSavedBody(body = {}) {
  const out = {};
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return { error: `status must be one of ${STATUSES.join(', ')}` };
    out.status = body.status;
  }
  if (body.note !== undefined) {
    const note = body.note == null ? '' : String(body.note).replace(/\s+/g, ' ').trim();
    if (note.length > MAX_NOTE) return { error: `note is longer than ${MAX_NOTE} characters` };
    out.note = note || null;
  }
  return out;
}

/**
 * The /api/me routes. Mount after the access gate.
 * @param {{store, permitsByIds: (ids: string[]) => Promise<object[]>, sessions?: object}} deps
 */
function router({ store, permitsByIds, sessions: sess = sessions() }) {
  const r = express.Router();
  const json = express.json({ limit: '4kb' });
  const onlyJson = (req, res, next) => (req.is('application/json') ? next() : res.status(415).json({ error: 'Send JSON' }));
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'Request failed' });
  });
  const noStore = (res) => res.set('Cache-Control', 'no-store');
  const signedIn = async (req) => {
    const id = sess.userId(req);
    return id ? store.get(id) : null;
  };
  const needUser = async (req, res) => {
    const user = await signedIn(req);
    if (!user) res.status(401).json({ error: 'Sign in with your email first', signIn: true });
    return user;
  };
  const permitIdOf = (req) => (/^\d{1,18}$/.test(req.params.id) ? req.params.id : null);

  r.get('/api/me', wrap(async (req, res) => {
    noStore(res);
    const user = await signedIn(req);
    if (!user) return res.json({ email: null, saved: [] });
    const saved = await store.listSaved(user.id);
    return res.json({ email: user.email, saved: saved.map((s) => ({ permitId: s.permitId, status: s.status })) });
  }));

  r.post('/api/me/signin', onlyJson, json, wrap(async (req, res) => {
    noStore(res);
    const email = normalEmail(req.body && req.body.email);
    if (!email) return res.status(400).json({ error: 'Enter a valid email address' });
    const user = await store.findOrCreate(email);
    sess.set(res, req, user.id);
    return res.json({ email: user.email });
  }));

  r.post('/api/me/signout', onlyJson, wrap(async (req, res) => {
    sess.clear(res, req);
    return res.json({ email: null });
  }));

  r.get('/api/me/saved', wrap(async (req, res) => {
    noStore(res);
    const user = await needUser(req, res);
    if (!user) return undefined;
    const saved = await store.listSaved(user.id);
    const permits = await permitsByIds(saved.map((s) => s.permitId));
    const byId = new Map(permits.map((p) => [String(p.id), p]));
    return res.json({
      email: user.email,
      statuses: STATUSES,
      items: saved.filter((s) => byId.has(s.permitId)).map((s) => ({ ...s, permit: byId.get(s.permitId) })),
    });
  }));

  r.put('/api/me/saved/:id', onlyJson, json, wrap(async (req, res) => {
    noStore(res);
    const user = await needUser(req, res);
    if (!user) return undefined;
    const permitId = permitIdOf(req);
    if (!permitId) return res.status(400).json({ error: 'Bad permit id' });
    const body = cleanSavedBody(req.body);
    if (body.error) return res.status(400).json({ error: body.error });
    // The cap only stops new saves; changing one already saved always works.
    if (await store.countSaved(user.id) >= MAX_SAVED
        && !(await store.listSaved(user.id)).some((s) => s.permitId === permitId)) {
      return res.status(409).json({ error: `You can save up to ${MAX_SAVED} permits` });
    }
    const saved = await store.upsertSaved(user.id, permitId, body);
    if (!saved) return res.status(404).json({ error: 'Permit not found' });
    return res.json(saved);
  }));

  r.delete('/api/me/saved/:id', wrap(async (req, res) => {
    noStore(res);
    const user = await needUser(req, res);
    if (!user) return undefined;
    const permitId = permitIdOf(req);
    if (!permitId) return res.status(400).json({ error: 'Bad permit id' });
    await store.removeSaved(user.id, permitId);
    return res.json({ removed: permitId });
  }));

  // Sign-out link when there is no access gate (local). With the gate on, its
  // own /logout is mounted first and clears this cookie too (web/access.js).
  r.get('/logout', (req, res) => {
    sess.clear(res, req);
    res.redirect(303, '/');
  });

  return r;
}

module.exports = { router, sessions, pgStore, normalEmail, cleanSavedBody, sessionKey, STATUSES, COOKIE, SESSION_MS };
