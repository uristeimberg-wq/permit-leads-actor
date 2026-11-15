// Product analytics ingestion: POST /api/telemetry/events (docs/ANALYTICS.md).
//
// One request is one batch from one browser session: the session's context
// plus up to 50 events. The batch is checked strictly (unknown event names,
// bad UUIDs, oversized fields: the whole batch is refused with 400, never
// half-written), every free-text value is redacted again here, since the
// client cannot be trusted to have done it, and then written in one
// transaction:
//   1. the session row is upserted (last_active_at only moves forward);
//   2. events are inserted with ON CONFLICT (event_id) DO NOTHING, so a retry
//      of the same batch writes nothing twice;
//   3. if the request carries a signed-in user's cookie, every earlier event
//      and session of this device gets that user_id (identity stitching);
//   4. the session's active duration is recomputed from its page_exit events.
//
// What is never stored: the IP address (country/region come only from a proxy
// header named in GEO_COUNTRY_HEADER / GEO_REGION_HEADER, else NULL), the full
// user-agent (only coarse families), the referrer's path or query, cookies,
// tokens, emails and phone numbers in any text. Requests with DNT: 1 or
// Sec-GPC: 1 are acknowledged and dropped. The owner's traffic (owner key) and
// the client's own "internal" flag mark the session internal; bots are marked
// is_bot. Both are kept, so the exclusion is auditable, and excluded from every
// metric (web/admin_analytics.js).

const express = require('express');
const core = require('./public/analytics_core.js');

const MAX_EVENTS = 50;
const MAX_BODY = '64kb';
const RATE_EVENTS_PER_MIN = 300;   // per client IP, in memory; the IP is never stored
const CLOCK_PAST_MS = 24 * 3600 * 1000;
const CLOCK_FUTURE_MS = 5 * 60 * 1000;

const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|curl|wget|python-|node-fetch|undici|axios|go-http|java\/|okhttp|playwright|puppeteer|phantom|selenium|monitor|uptime|^node$|pingdom|facebookexternalhit|embedly/i;

/** Coarse families from a user-agent string. The string itself is not kept. */
function parseUserAgent(ua) {
  const s = String(ua || '');
  const bot = !s || BOT_UA.test(s);
  let device = 'desktop';
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(s)) device = 'tablet';
  else if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(s)) device = 'mobile';
  else if (!s) device = 'unknown';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung Internet'
    : /Firefox\/|FxiOS/.test(s) ? 'Firefox' : /CriOS|Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : s ? 'Other' : null;
  const os = /Windows/.test(s) ? 'Windows' : /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android'
    : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : s ? 'Other' : null;
  return { device_type: device, browser, os, bot };
}

const str = (v, max) => (v == null || v === '' ? null : core.redactText(String(v), max));
const isPath = (v) => typeof v === 'string' && /^\/[^\s?#]*$/.test(v) && v.length <= 300;
const HOST = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i;

/**
 * The batch, cleaned, or { error }. `now` is the server clock.
 * @returns {{error: string} | {session: object, events: object[]}}
 */
function validateBatch(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Body must be a JSON object' };
  const { session_id: sid, anonymous_device_id: did, events } = body;
  if (!core.UUID.test(String(sid || ''))) return { error: 'session_id must be a UUID' };
  if (!core.UUID.test(String(did || ''))) return { error: 'anonymous_device_id must be a UUID' };
  if (!Array.isArray(events) || !events.length) return { error: 'events must be a non-empty array' };
  if (events.length > MAX_EVENTS) return { error: `At most ${MAX_EVENTS} events per batch` };

  const s = body.session && typeof body.session === 'object' ? body.session : {};
  const referrer = typeof s.referrer === 'string' && HOST.test(s.referrer) ? s.referrer.toLowerCase() : null;
  const session = {
    session_id: sid.toLowerCase(),
    anonymous_device_id: did.toLowerCase(),
    entry_path: isPath(s.entry_path) ? s.entry_path : null,
    referrer,
    utm_source: str(s.utm_source, 100),
    utm_medium: str(s.utm_medium, 100),
    utm_campaign: str(s.utm_campaign, 100),
    internal: body.internal === true,
  };

  const seen = new Set();
  const out = [];
  for (const [i, e] of events.entries()) {
    if (!e || typeof e !== 'object') return { error: `events[${i}] must be an object` };
    if (!core.UUID.test(String(e.event_id || ''))) return { error: `events[${i}].event_id must be a UUID` };
    const id = e.event_id.toLowerCase();
    if (seen.has(id)) continue;   // the same event twice in one batch: keep the first
    seen.add(id);
    const category = core.EVENTS[e.event_name];
    if (!category) return { error: `events[${i}].event_name is not in the taxonomy` };
    const t = Date.parse(e.client_timestamp);
    if (!Number.isFinite(t)) return { error: `events[${i}].client_timestamp must be an ISO time` };
    // A wrong device clock must not put events in another month.
    const ts = t < now - CLOCK_PAST_MS || t > now + CLOCK_FUTURE_MS ? now : t;
    const type = e.target_entity_type == null ? null : e.target_entity_type;
    if (type !== null && !core.ENTITY_TYPES.includes(type)) return { error: `events[${i}].target_entity_type is not known` };
    if (e.page_path != null && !isPath(e.page_path)) return { error: `events[${i}].page_path must be a path without a query` };
    const rec = e.target_record_id == null ? null : String(e.target_record_id);
    if (rec !== null && !/^[\w.:-]{1,100}$/.test(rec)) return { error: `events[${i}].target_record_id is malformed` };
    const props = core.sanitizeProps(e.properties || {});
    out.push({
      event_id: id,
      event_name: e.event_name,
      event_category: category,
      page_path: e.page_path || null,
      page_title: str(e.page_title, 200),
      element_id: e.element_id == null ? null : String(e.element_id).replace(/[^\w:.-]/g, '').slice(0, 100) || null,
      element_label: str(e.element_label, 120),
      target_record_id: rec,
      target_entity_type: type,
      properties: props,
      client_timestamp: new Date(ts).toISOString(),
    });
  }
  return { session, events: out };
}

/** Country/region from the configured proxy headers only; never from the IP. */
function geoFrom(req, env = process.env) {
  const c = env.GEO_COUNTRY_HEADER ? String(req.get(env.GEO_COUNTRY_HEADER) || '').toUpperCase() : '';
  const r = env.GEO_REGION_HEADER ? String(req.get(env.GEO_REGION_HEADER) || '') : '';
  return { ip_country: /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null, ip_region: r ? r.slice(0, 80) : null };
}

/** The store over Postgres. `pool` has connect() (db/index.js getPool()). */
function pgStore(getPool) {
  return {
    /**
     * Write one validated batch. Returns { accepted, duplicates } or
     * { conflict: true } when the session id belongs to another device.
     */
    async ingest({ session, events, userId = null, internal = false, ua = {}, geo = {} }) {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        const times = events.map((e) => e.client_timestamp).sort();
        const first = times[0];
        const last = times[times.length - 1];
        const { rows: sessionRows } = await client.query(`
          INSERT INTO analytics_sessions (session_id, user_id, anonymous_device_id, started_at, last_active_at,
            entry_path, referrer, utm_source, utm_medium, utm_campaign, device_type, browser, os, ip_country, ip_region,
            is_internal, is_bot)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
            $16 OR EXISTS (SELECT 1 FROM analytics_internal_devices WHERE anonymous_device_id = $3)
                OR EXISTS (SELECT 1 FROM analytics_internal_users WHERE user_id = $2), $17)
          ON CONFLICT (session_id) DO UPDATE SET
            user_id        = coalesce(analytics_sessions.user_id, EXCLUDED.user_id),
            started_at     = least(analytics_sessions.started_at, EXCLUDED.started_at),
            last_active_at = greatest(analytics_sessions.last_active_at, EXCLUDED.last_active_at),
            is_internal    = analytics_sessions.is_internal OR EXCLUDED.is_internal,
            is_bot         = analytics_sessions.is_bot OR EXCLUDED.is_bot
          WHERE analytics_sessions.anonymous_device_id = EXCLUDED.anonymous_device_id
          RETURNING session_id`,
        [session.session_id, userId, session.anonymous_device_id, first, last,
          session.entry_path, session.referrer, session.utm_source, session.utm_medium, session.utm_campaign,
          ua.device_type || 'unknown', ua.browser || null, ua.os || null, geo.ip_country || null, geo.ip_region || null,
          Boolean(internal), Boolean(ua.bot)]);
        if (!sessionRows.length) { await client.query('ROLLBACK'); return { conflict: true }; }

        const { rows: inserted } = await client.query(`
          INSERT INTO analytics_events (event_id, session_id, user_id, anonymous_device_id, event_name, event_category,
            page_path, page_title, element_id, element_label, target_record_id, target_entity_type, properties, client_timestamp)
          SELECT e.event_id, $2, $3, $4, e.event_name, e.event_category, e.page_path, e.page_title, e.element_id,
                 e.element_label, e.target_record_id, e.target_entity_type, coalesce(e.properties, '{}'::jsonb), e.client_timestamp
            FROM jsonb_to_recordset($1::jsonb) AS e(event_id uuid, event_name text, event_category text, page_path text,
                 page_title text, element_id text, element_label text, target_record_id text, target_entity_type text,
                 properties jsonb, client_timestamp timestamptz)
          ON CONFLICT (event_id) DO NOTHING
          RETURNING event_id`,
        [JSON.stringify(events), session.session_id, userId, session.anonymous_device_id]);

        if (userId) {
          await client.query(`INSERT INTO analytics_identities (anonymous_device_id, user_id) VALUES ($1, $2)
                              ON CONFLICT DO NOTHING`, [session.anonymous_device_id, userId]);
          await client.query(`UPDATE analytics_events SET user_id = $2
                               WHERE anonymous_device_id = $1 AND user_id IS NULL`, [session.anonymous_device_id, userId]);
          await client.query(`UPDATE analytics_sessions SET user_id = $2
                               WHERE anonymous_device_id = $1 AND user_id IS NULL`, [session.anonymous_device_id, userId]);
          // The owner signed in with an email on this device: the whole device is theirs.
          await client.query(`UPDATE analytics_sessions SET is_internal = true
                               WHERE anonymous_device_id = $1 AND NOT is_internal
                                 AND EXISTS (SELECT 1 FROM analytics_internal_users WHERE user_id = $2)`, [session.anonymous_device_id, userId]);
        }

        // Active time: per page view, the longest visible time it reported.
        // Exit path: the last page viewed. Ended: when the last event is a final exit.
        await client.query(`
          UPDATE analytics_sessions s SET
            duration_seconds = coalesce((
              SELECT (sum(v.ms) / 1000)::int FROM (
                SELECT max(least((e.properties->>'dwell_time_ms')::numeric, 86400000)) AS ms
                  FROM analytics_events e
                 WHERE e.session_id = s.session_id AND e.event_name = 'page_exit'
                   AND jsonb_typeof(e.properties->'dwell_time_ms') = 'number'
                   AND (e.properties->>'dwell_time_ms')::numeric >= 0
                 GROUP BY coalesce(e.properties->>'view_id', e.event_id::text)) v), 0),
            exit_path = (SELECT e.page_path FROM analytics_events e
                          WHERE e.session_id = s.session_id AND e.event_name = 'page_view'
                          ORDER BY e.client_timestamp DESC LIMIT 1),
            ended_at = (SELECT CASE WHEN e.event_name = 'page_exit' AND e.properties->>'final' = 'true' THEN e.client_timestamp END
                          FROM analytics_events e WHERE e.session_id = s.session_id
                          ORDER BY e.client_timestamp DESC, e.server_received_at DESC LIMIT 1)
          WHERE s.session_id = $1`, [session.session_id]);
        await client.query('COMMIT');
        return { accepted: inserted.length, duplicates: events.length - inserted.length };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

function rateLimiter({ perMinute = RATE_EVENTS_PER_MIN, now = Date.now } = {}) {
  const hits = new Map();   // ip -> { n, since }; never written anywhere
  return (ip, n) => {
    const t = now();
    const h = hits.get(ip);
    if (!h || t - h.since > 60000) { hits.set(ip, { n, since: t }); if (hits.size > 20000) hits.clear(); return true; }
    h.n += n;
    return h.n <= perMinute;
  };
}

/**
 * The ingestion router.
 * @param {{store, userIdOf: (req) => number|null, isOwner: (req) => boolean, env?: object, limiter?: Function}} deps
 */
function router({ store, userIdOf = () => null, isOwner = () => false, env = process.env, limiter = rateLimiter() }) {
  const r = express.Router();
  // sendBeacon may arrive as text/plain on old browsers: parse both as JSON.
  const json = express.json({ limit: MAX_BODY, type: ['application/json', 'text/plain'] });
  r.post('/api/telemetry/events', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.get('dnt') === '1' || req.get('sec-gpc') === '1') return res.status(204).end();
    return json(req, res, (err) => {
      if (err) return res.status(err.type === 'entity.too.large' ? 413 : 400).json({ error: err.type === 'entity.too.large' ? 'Batch too large' : 'Malformed JSON' });
      return next();
    });
  }, async (req, res) => {
    const batch = validateBatch(req.body);
    if (batch.error) return res.status(400).json({ error: batch.error });
    if (!limiter(req.ip || 'unknown', batch.events.length)) return res.status(429).json({ error: 'Too many events' });
    try {
      const out = await store.ingest({
        session: batch.session,
        events: batch.events,
        userId: userIdOf(req) || null,
        internal: batch.session.internal || isOwner(req),
        ua: parseUserAgent(req.get('user-agent')),
        geo: geoFrom(req, env),
      });
      if (out.conflict) return res.status(409).json({ error: 'session_id belongs to another device' });
      return res.status(202).json(out);
    } catch (err) {
      // Logged with its class (rule 3); the client keeps the batch and retries.
      console.error(`telemetry ingest failed (${err.code || err.name}): ${err.message}`);
      return res.status(503).json({ error: 'Could not store events' });
    }
  });
  return r;
}

module.exports = { router, pgStore, validateBatch, parseUserAgent, geoFrom, rateLimiter, MAX_EVENTS };
