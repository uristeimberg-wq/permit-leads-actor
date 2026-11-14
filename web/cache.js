// In-memory response cache for the read-only screen APIs.
//
// Why: the data changes once a day (the daily sync), but every screen used to
// recompute its numbers from the whole permits table on each visit, and the
// first visit after a few idle minutes also paid for Neon Free waking its
// suspended compute. Serving the last computed answer from memory makes
// opening the app fast; recomputing in the background keeps it current.
//
// Rules:
//   - fresh (younger than freshMs): served from memory.
//   - stale (younger than staleMs): served from memory at once, and recomputed
//     in the background so the next visit gets the new answer. Every payload
//     carries its own lastSyncAt, so a stale answer never claims freshness it
//     doesn't have (CLAUDE.md rule 7); the Age header says how old it is.
//   - older, or missing: computed while the request waits.
//   - a failed background recompute keeps the old answer and is logged; a
//     failed blocking one is a 500, as before.
// Bodies are stored serialized and gzipped once, so a hit costs no JSON or
// compression work, and an ETag lets a browser revalidate with a 304.
//
// The cache sits behind the demo gate, and responses don't vary by viewer
// (one shared demo password), so one entry per URL is correct. Set
// API_CACHE=off to disable it (the integration suites do, to see writes).

const crypto = require('node:crypto');
const zlib = require('node:zlib');

function createCache({
  freshMs = 10 * 60 * 1000,
  staleMs = 36 * 3600 * 1000,
  max = 300,
  enabled = process.env.API_CACHE !== 'off',
  now = () => Date.now(),
  log = (msg) => console.error(msg),
} = {}) {
  const entries = new Map(); // key -> { at, body, gz, etag }, in LRU order
  const pending = new Map(); // key -> Promise<entry>

  function build(out) {
    // compute may answer { status, json } for a non-200 (a 404 for an unknown
    // id); that is cached like any answer, since it only changes with a sync.
    const status = out && out.status && out.json ? out.status : 200;
    const body = Buffer.from(JSON.stringify(status === 200 ? out : out.json));
    return {
      at: now(),
      status,
      body,
      gz: body.length > 1024 ? zlib.gzipSync(body, { level: 6 }) : null,
      etag: `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 27)}"`,
    };
  }

  function refresh(key, compute) {
    if (pending.has(key)) return pending.get(key);
    const p = Promise.resolve()
      .then(compute)
      .then((data) => {
        const e = build(data);
        if (enabled) {
          entries.delete(key);
          entries.set(key, e);
          while (entries.size > max) entries.delete(entries.keys().next().value);
        }
        return e;
      })
      .finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  }

  /** The entry for `key`, and how it was found: hit, stale or miss. */
  async function get(key, compute) {
    const e = enabled ? entries.get(key) : null;
    const age = e ? now() - e.at : Infinity;
    if (e && age < freshMs) {
      entries.delete(key); entries.set(key, e); // LRU touch
      return { entry: e, state: 'hit' };
    }
    if (e && age < staleMs) {
      refresh(key, compute).catch((err) => log(`cache: background refresh of ${key} failed: ${err.message}`));
      return { entry: e, state: 'stale' };
    }
    return { entry: await refresh(key, compute), state: 'miss' };
  }

  /** Sends an entry: 304 on a matching ETag, gzip when the client takes it. */
  function send(req, res, { entry, state }) {
    res.set('ETag', entry.etag);
    res.set('X-Cache', state);
    res.set('Age', String(Math.max(0, Math.floor((now() - entry.at) / 1000))));
    // The browser keeps a copy but asks again each time; the answer to that
    // question is a 304 from memory, so it is cheap.
    res.set('Cache-Control', 'private, no-cache');
    res.set('Vary', 'Accept-Encoding');
    if (entry.status === 200 && req.get('if-none-match') === entry.etag) return res.status(304).end();
    res.status(entry.status);
    res.type('application/json');
    if (entry.gz && /\bgzip\b/.test(req.get('accept-encoding') || '')) {
      res.set('Content-Encoding', 'gzip');
      return res.send(entry.gz);
    }
    return res.send(entry.body);
  }

  /**
   * Express handler: `compute(req)` returns the JSON to send, or
   * { status, json } for a non-200 answer.
   */
  function route(compute, keyOf = (req) => req.originalUrl) {
    return async (req, res) => {
      try {
        return send(req, res, await get(keyOf(req), () => compute(req)));
      } catch (err) {
        // No SQL or stack to the client; the log has the detail.
        console.error(err);
        return res.status(500).json({ error: 'Query failed' });
      }
    };
  }

  /** Computes `keys` ahead of the first visitor (on boot). Failures are logged only. */
  function warm(list) {
    return Promise.all(list.map(([key, compute]) =>
      refresh(key, compute).catch((err) => log(`cache: warm-up of ${key} failed: ${err.message}`))));
  }

  return { get, send, route, warm, size: () => entries.size, clear: () => entries.clear() };
}

module.exports = { createCache };

// The app's one shared cache (web/server.js, web/pilot_api.js, web/overview_api.js).
module.exports.cache = createCache();
