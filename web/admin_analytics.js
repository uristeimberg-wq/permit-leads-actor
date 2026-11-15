// The owner's product analytics: /admin/analytics and /api/admin/analytics/*
// (docs/ANALYTICS.md, ADR-37).
//
// Owner only. The access gate (web/access.js ownerOnly) already refuses these
// paths without the owner key; requireOwner below checks again, so a mistake
// in server.js wiring cannot open them. No owner key configured means no
// owner, so the dashboard is closed (403) rather than open on a shared host.
//
// Every number is a SQL aggregate over analytics_sessions/analytics_events,
// with the owner's own sessions (is_internal) and automated clients (is_bot)
// left out. Nothing is seeded or estimated: with no traffic, every panel is
// empty and says so. Times are UTC.
//
// An "actor" is a registered user, else a device: coalesce(user_id, device).
// Stitching (web/telemetry.js) gives a device's earlier anonymous rows the
// user's id, so one person is one actor after they sign in.

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { HIGH_INTENT } = require('./public/analytics_core.js');

const RANGES = { today: null, '7d': 7, '30d': 30, all: null };

/** The range's start as an ISO string, or null for all time. */
function rangeStart(range, now = new Date()) {
  if (range === 'today') { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); }
  const days = RANGES[range];
  return days ? new Date(now.getTime() - days * 86400000).toISOString() : null;
}

function parseScope(q = {}) {
  const range = Object.prototype.hasOwnProperty.call(RANGES, q.range) ? q.range : '7d';
  const userId = /^\d{1,18}$/.test(String(q.user || '')) ? Number(q.user) : null;
  return { range, since: rangeStart(range), userId };
}

// Sessions and events that count: not internal, not bots, in range, for the user if one is chosen.
const SCOPED = `
  s AS (SELECT * FROM analytics_sessions WHERE NOT is_internal AND NOT is_bot),
  e AS (SELECT e.*, coalesce(e.user_id::text, 'd:' || e.anonymous_device_id::text) AS actor
          FROM analytics_events e JOIN s USING (session_id)
         WHERE ($1::timestamptz IS NULL OR e.client_timestamp >= $1)
           AND ($2::bigint IS NULL OR e.user_id = $2))`;

async function summary(query, { since, userId }) {
  const p = [since, userId];
  const one = async (sql, params = p) => (await query(sql, params)).rows[0] || {};
  const many = async (sql, params = p) => (await query(sql, params)).rows;

  const [activity, totals, conversion, retention, searchTerms, areas, stages, filters, zero, records, funnel, paths, elements, errors, excluded] = await Promise.all([
    // DAU/WAU/MAU are fixed windows ending now. Stickiness is the mean daily
    // actives over MAU, averaged over the days with tracking in the last 30:
    // while there is less than 30 days of data, dividing by 30 would count
    // days before launch as zero-user days (1 user on day one read 3%).
    one(`WITH ${SCOPED},
      a AS (SELECT DISTINCT date_trunc('day', s.started_at) AS d, coalesce(s.user_id::text, 'd:' || s.anonymous_device_id::text) AS actor
              FROM s WHERE s.started_at >= now() - interval '30 days' AND ($2::bigint IS NULL OR s.user_id = $2))
      SELECT (SELECT count(DISTINCT actor) FROM a WHERE d >= date_trunc('day', now()))::int AS dau,
             (SELECT count(DISTINCT actor) FROM a WHERE d >= date_trunc('day', now()) - interval '6 days')::int AS wau,
             (SELECT count(DISTINCT actor) FROM a)::int AS mau,
             (SELECT count(*)::float FROM a) AS active_days_30d,
             (SELECT least(30, (date_trunc('day', now())::date - date_trunc('day', min(started_at))::date) + 1)
                FROM s WHERE ($2::bigint IS NULL OR s.user_id = $2)) AS days_tracked`),
    one(`WITH ${SCOPED},
      ss AS (SELECT * FROM s WHERE ($1::timestamptz IS NULL OR s.started_at >= $1) AND ($2::bigint IS NULL OR s.user_id = $2))
      SELECT (SELECT count(*) FROM ss)::int AS sessions,
             (SELECT count(DISTINCT coalesce(user_id::text, 'd:' || anonymous_device_id::text)) FROM ss)::int AS actors,
             (SELECT round(avg(duration_seconds))::int FROM ss) AS avg_active_seconds,
             (SELECT count(*) FROM e)::int AS events,
             (SELECT count(*) FROM e WHERE event_name = 'search_executed')::int AS searches,
             (SELECT max(server_received_at) FROM analytics_events) AS last_event_at`),
    // Devices first seen in range, and how many of them became a registered user.
    one(`WITH s AS (SELECT * FROM analytics_sessions WHERE NOT is_internal AND NOT is_bot),
      d AS (SELECT anonymous_device_id, min(started_at) AS first FROM s GROUP BY 1)
      SELECT count(*)::int AS devices,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM analytics_identities i WHERE i.anonymous_device_id = d.anonymous_device_id))::int AS registered
        FROM d WHERE ($1::timestamptz IS NULL OR d.first >= $1) AND $2::bigint IS NOT DISTINCT FROM $2::bigint`),
    // Cohort: actors whose first session is in range. Returned at N: any
    // session starting N or more days after the first. Eligible: first
    // session at least N days ago, so recent arrivals do not drag the rate down.
    many(`WITH s AS (SELECT *, coalesce(user_id::text, 'd:' || anonymous_device_id::text) AS actor
                       FROM analytics_sessions WHERE NOT is_internal AND NOT is_bot AND ($2::bigint IS NULL OR user_id = $2)),
      f AS (SELECT actor, min(started_at) AS first FROM s GROUP BY 1),
      c AS (SELECT * FROM f WHERE $1::timestamptz IS NULL OR first >= $1)
      SELECT n.day,
             count(*) FILTER (WHERE c.first <= now() - make_interval(days => n.day))::int AS eligible,
             count(*) FILTER (WHERE c.first <= now() - make_interval(days => n.day) AND EXISTS (
               SELECT 1 FROM s WHERE s.actor = c.actor AND s.started_at >= c.first + make_interval(days => n.day)))::int AS returned
        FROM (VALUES (1), (7), (30)) AS n(day) CROSS JOIN c GROUP BY n.day ORDER BY n.day`),
    many(`WITH ${SCOPED}
      SELECT lower(properties->>'query') AS term, count(*)::int AS searches, count(DISTINCT actor)::int AS actors,
             count(*) FILTER (WHERE properties->>'zero_results' = 'true')::int AS zero
        FROM e WHERE event_name = 'search_executed' AND coalesce(properties->>'query', '') <> ''
       GROUP BY 1 ORDER BY searches DESC, term LIMIT 25`),
    many(`WITH ${SCOPED}
      SELECT trim(a) AS area, count(*)::int AS searches
        FROM e, unnest(string_to_array(e.properties->'filters'->>'areas', ',')) AS a
       WHERE event_name = 'search_executed' AND trim(a) <> ''
       GROUP BY 1 ORDER BY searches DESC, area LIMIT 25`),
    many(`WITH ${SCOPED}
      SELECT coalesce(nullif(trim(st), ''), 'default') AS stage, count(*)::int AS searches
        FROM e, unnest(coalesce(string_to_array(e.properties->'filters'->>'stage', ','), ARRAY['default'])) AS st
       WHERE event_name = 'search_executed'
       GROUP BY 1 ORDER BY searches DESC LIMIT 12`),
    many(`WITH ${SCOPED}
      SELECT properties->>'filter' AS filter, count(*) FILTER (WHERE event_name = 'filter_applied')::int AS applied,
             count(*) FILTER (WHERE event_name = 'filter_cleared')::int AS cleared
        FROM e WHERE event_name IN ('filter_applied', 'filter_cleared') AND properties->>'filter' IS NOT NULL
       GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 20`),
    many(`WITH ${SCOPED}
      SELECT coalesce(properties->>'query', '') AS query, properties->'filters' AS filters, properties->>'view' AS view,
             count(*)::int AS times, count(DISTINCT actor)::int AS actors, max(client_timestamp) AS last_at
        FROM e WHERE event_name = 'search_executed' AND properties->>'zero_results' = 'true'
       GROUP BY 1, 2, 3 ORDER BY times DESC, last_at DESC LIMIT 50`),
    many(`WITH ${SCOPED},
      r AS (SELECT target_entity_type AS type, target_record_id AS id,
                   count(*) FILTER (WHERE event_name = 'record_clicked')::int AS clicks,
                   count(*) FILTER (WHERE event_name = 'record_detail_viewed')::int AS views,
                   coalesce(sum(least((properties->>'read_time_ms')::numeric, 3600000)) FILTER (
                     WHERE event_name = 'record_detail_viewed' AND jsonb_typeof(properties->'read_time_ms') = 'number'), 0)::bigint AS read_ms,
                   count(DISTINCT actor)::int AS actors
              FROM e WHERE event_name IN ('record_clicked', 'record_detail_viewed') AND target_record_id IS NOT NULL
             GROUP BY 1, 2 ORDER BY count(*) DESC, 5 DESC LIMIT 30)
      SELECT r.*, CASE WHEN r.type = 'permit' THEN (SELECT p.address FROM permits p
                    WHERE r.id ~ '^[0-9]{1,18}$' AND p.id = r.id::bigint) END AS label
        FROM r ORDER BY r.views + r.clicks DESC, r.read_ms DESC`),
    // Ordered: each step's first time at or after the previous step's.
    many(`WITH ${SCOPED},
      f AS (SELECT actor,
                   min(client_timestamp) FILTER (WHERE event_name = 'page_view') AS landed,
                   min(client_timestamp) FILTER (WHERE event_name = 'search_executed') AS searched,
                   array_agg(client_timestamp) FILTER (WHERE event_name IN ('record_clicked', 'record_detail_viewed')) AS opened,
                   array_agg(client_timestamp) FILTER (WHERE event_name = ANY($3::text[])) AS intent
              FROM e GROUP BY actor),
      g AS (SELECT actor, landed, searched,
                   (SELECT min(t) FROM unnest(opened) t WHERE t >= searched) AS opened_at
              FROM f),
      h AS (SELECT g.*, (SELECT min(t) FROM unnest(f.intent) t WHERE t >= g.opened_at) AS intent_at FROM g JOIN f USING (actor))
      SELECT count(*) FILTER (WHERE landed IS NOT NULL)::int AS landed,
             count(*) FILTER (WHERE searched >= landed)::int AS searched,
             count(*) FILTER (WHERE searched >= landed AND opened_at IS NOT NULL)::int AS opened,
             count(*) FILTER (WHERE searched >= landed AND intent_at IS NOT NULL)::int AS intent,
             count(*) FILTER (WHERE searched >= landed AND intent_at IS NOT NULL AND EXISTS (
               SELECT 1 FROM s WHERE coalesce(s.user_id::text, 'd:' || s.anonymous_device_id::text) = h.actor
                                 AND s.started_at > h.intent_at))::int AS returned
        FROM h`, [...p, HIGH_INTENT]),
    many(`WITH ${SCOPED},
      v AS (SELECT session_id, page_path,
                   lead(page_path) OVER (PARTITION BY session_id ORDER BY client_timestamp) AS next_path
              FROM e WHERE event_name = 'page_view')
      SELECT page_path AS from_path, next_path AS to_path, count(*)::int AS times
        FROM v WHERE next_path IS NOT NULL GROUP BY 1, 2 ORDER BY times DESC LIMIT 20`),
    many(`WITH ${SCOPED}
      SELECT event_name, coalesce(element_id, '') AS element_id, coalesce(element_label, '') AS element_label,
             count(*)::int AS clicks, count(DISTINCT actor)::int AS actors
        FROM e WHERE element_id IS NOT NULL OR event_name IN ('external_source_link_clicked', 'contact_info_clicked')
       GROUP BY 1, 2, 3 ORDER BY clicks DESC LIMIT 25`),
    many(`WITH ${SCOPED}
      SELECT event_name, coalesce(properties->>'endpoint', properties->>'message', page_path) AS detail,
             count(*)::int AS times, max(client_timestamp) AS last_at
        FROM e WHERE event_category = 'error'
       GROUP BY 1, 2 ORDER BY times DESC LIMIT 20`),
    one(`SELECT count(*) FILTER (WHERE is_internal)::int AS internal, count(*) FILTER (WHERE is_bot)::int AS bots
           FROM analytics_sessions WHERE ($1::timestamptz IS NULL OR started_at >= $1) AND $2::bigint IS NOT DISTINCT FROM $2::bigint`),
  ]);

  const mau = activity.mau;
  return {
    activity: {
      dau: activity.dau, wau: activity.wau, mau,
      daysTracked: activity.days_tracked || 0,
      stickiness: mau && activity.days_tracked ? activity.active_days_30d / activity.days_tracked / mau : null,
    },
    totals,
    conversion: { ...conversion, rate: conversion.devices ? conversion.registered / conversion.devices : null },
    retention: retention.length ? retention : [1, 7, 30].map((day) => ({ day, eligible: 0, returned: 0 })),
    search: { terms: searchTerms, areas, stages, filters, zero },
    records,
    funnel: funnel[0] || {},
    paths,
    elements,
    errors,
    excluded,
  };
}

async function listUsers(query) {
  const { rows } = await query(`
    SELECT u.id, u.email, u.created_at,
           count(DISTINCT s.session_id)::int AS sessions,
           max(s.last_active_at) AS last_active_at,
           coalesce(sum(s.duration_seconds), 0)::int AS active_seconds,
           (SELECT count(*) FROM analytics_events e WHERE e.user_id = u.id AND e.event_name = 'search_executed')::int AS searches,
           (SELECT count(*) FROM saved_permits sp WHERE sp.user_id = u.id)::int AS saved
      FROM app_users u
      LEFT JOIN analytics_sessions s ON s.user_id = u.id AND NOT s.is_internal AND NOT s.is_bot
     GROUP BY u.id ORDER BY max(s.last_active_at) DESC NULLS LAST, u.created_at DESC LIMIT 500`);
  return rows;
}

/** One user's sessions, each with its events in order. */
async function timeline(query, userId, { limit = 2000 } = {}) {
  const { rows: [user] } = await query('SELECT id, email, created_at FROM app_users WHERE id = $1', [userId]);
  if (!user) return null;
  const { rows: sessions } = await query(`
    SELECT session_id, started_at, last_active_at, ended_at, duration_seconds, entry_path, exit_path, referrer,
           utm_source, utm_medium, utm_campaign, device_type, browser, os, ip_country, is_internal, is_bot
      FROM analytics_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 200`, [userId]);
  const { rows: events } = await query(`
    SELECT event_id, session_id, event_name, event_category, page_path, element_id, element_label,
           target_record_id, target_entity_type, properties, client_timestamp
      FROM analytics_events WHERE user_id = $1 ORDER BY client_timestamp DESC LIMIT $2`, [userId, limit]);
  const bySession = new Map(sessions.map((s) => [s.session_id, { ...s, events: [] }]));
  for (const ev of events) { const s = bySession.get(ev.session_id); if (s) s.events.push(ev); }
  for (const s of bySession.values()) s.events.reverse();
  return { user, sessions: [...bySession.values()], truncated: events.length === limit };
}

// ── CSV ─────────────────────────────────────────────────────────────────────
const EXPORTS = {
  events: {
    columns: ['event_id', 'session_id', 'user_id', 'anonymous_device_id', 'event_name', 'event_category', 'page_path',
      'element_id', 'element_label', 'target_entity_type', 'target_record_id', 'properties', 'client_timestamp', 'server_received_at'],
    sql: `SELECT e.event_id, e.session_id, e.user_id, e.anonymous_device_id, e.event_name, e.event_category, e.page_path,
                 e.element_id, e.element_label, e.target_entity_type, e.target_record_id, e.properties, e.client_timestamp, e.server_received_at
            FROM analytics_events e JOIN analytics_sessions s USING (session_id)
           WHERE NOT s.is_internal AND NOT s.is_bot AND ($1::timestamptz IS NULL OR e.client_timestamp >= $1)
             AND ($2::bigint IS NULL OR e.user_id = $2)
           ORDER BY e.client_timestamp LIMIT 100000`,
  },
  sessions: {
    columns: ['session_id', 'user_id', 'anonymous_device_id', 'started_at', 'last_active_at', 'ended_at', 'duration_seconds',
      'entry_path', 'exit_path', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'device_type', 'browser', 'os', 'ip_country', 'ip_region'],
    sql: `SELECT session_id, user_id, anonymous_device_id, started_at, last_active_at, ended_at, duration_seconds, entry_path, exit_path,
                 referrer, utm_source, utm_medium, utm_campaign, device_type, browser, os, ip_country, ip_region
            FROM analytics_sessions WHERE NOT is_internal AND NOT is_bot AND ($1::timestamptz IS NULL OR started_at >= $1)
             AND ($2::bigint IS NULL OR user_id = $2)
           ORDER BY started_at LIMIT 100000`,
  },
  searches: {
    columns: ['client_timestamp', 'user_id', 'anonymous_device_id', 'query', 'filters', 'view', 'results_count', 'zero_results'],
    sql: `SELECT e.client_timestamp, e.user_id, e.anonymous_device_id, e.properties->>'query' AS query, e.properties->'filters' AS filters,
                 e.properties->>'view' AS view, e.properties->>'results_count' AS results_count, e.properties->>'zero_results' AS zero_results
            FROM analytics_events e JOIN analytics_sessions s USING (session_id)
           WHERE e.event_name = 'search_executed' AND NOT s.is_internal AND NOT s.is_bot
             AND ($1::timestamptz IS NULL OR e.client_timestamp >= $1) AND ($2::bigint IS NULL OR e.user_id = $2)
           ORDER BY e.client_timestamp LIMIT 100000`,
  },
};

/** One CSV cell. A leading = + - @ is prefixed with ' so a spreadsheet does not run it. */
function csvCell(v) {
  if (v == null) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (columns, rows) => [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';

const PAGE_HTML = path.join(__dirname, 'admin', 'analytics.html');

/**
 * @param {{query: Function, isOwner: (req) => boolean}} deps
 */
function router({ query, isOwner }) {
  const r = express.Router();
  const requireOwner = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    if (isOwner(req)) return next();
    return res.status(403).json({ error: 'Owner only' });
  };
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    console.error(`admin analytics failed (${err.code || err.name}): ${err.message}`);
    res.status(500).json({ error: 'Query failed' });
  });

  r.get(['/admin/analytics', '/admin/analytics/'], requireOwner, (_req, res) => res.sendFile(PAGE_HTML));
  r.get('/admin/analytics/page.js', requireOwner, (_req, res) => res.type('js').sendFile(path.join(__dirname, 'admin', 'analytics_page.js')));
  r.get('/api/admin/analytics/summary', requireOwner, wrap(async (req, res) => {
    const scope = parseScope(req.query);
    res.json({ scope, generatedAt: new Date().toISOString(), ...(await summary(query, scope)) });
  }));
  r.get('/api/admin/analytics/users', requireOwner, wrap(async (_req, res) => res.json({ users: await listUsers(query) })));
  r.get('/api/admin/analytics/users/:id/timeline', requireOwner, wrap(async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'Bad user id' });
    const t = await timeline(query, Number(req.params.id));
    return t ? res.json(t) : res.status(404).json({ error: 'No such user' });
  }));
  r.get('/api/admin/analytics/export.csv', requireOwner, wrap(async (req, res) => {
    const kind = EXPORTS[req.query.kind] ? req.query.kind : null;
    if (!kind) return res.status(400).json({ error: `kind must be one of ${Object.keys(EXPORTS).join(', ')}` });
    const scope = parseScope(req.query);
    const { rows } = await query(EXPORTS[kind].sql, [scope.since, scope.userId]);
    res.type('text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="analytics-${kind}-${scope.range}${scope.userId ? `-user${scope.userId}` : ''}.csv"`);
    return res.send(toCsv(EXPORTS[kind].columns, rows));
  }));
  return r;
}

module.exports = { router, summary, listUsers, timeline, parseScope, rangeStart, csvCell, toCsv, EXPORTS };

// Fail fast at boot if the page is missing from the image.
if (!fs.existsSync(PAGE_HTML)) console.warn(`admin analytics: ${PAGE_HTML} is missing`);
