// The charts on the owner's analytics dashboard (/admin/analytics, ADR-37,
// docs/ANALYTICS.md): growth over time, records added per day, the funnel, the
// pop-up roles side by side, and traffic sources. Every series is a SQL
// aggregate over real rows; nothing is seeded, smoothed or projected.
//
// Same exclusions as the rest of the dashboard: the owner's own sessions
// (is_internal) and automated clients (is_bot) never count. Days are UTC.
// An actor is a signed-in user, else a browser (see web/admin_analytics.js).
//
// Role = the visitor's latest answer to the "What do you do?" pop-up
// (web/public/lens.js), carried on page views and on the pop-up's own events.
// Someone who picked two roles counts in both. 'skipped' = closed the pop-up
// without answering; 'none' = no answer recorded on this browser (for
// example, a visit before Nov 16 2026, when the answer started being recorded).

const { HIGH_INTENT, ROLES } = require('./public/analytics_core.js');

const CHART_DAYS = [7, 30, 90];
const ROLE_FILTERS = [...ROLES, 'skipped', 'none'];

/** The query's filters, validated: { days, role, source }. */
function parseChartScope(q = {}) {
  const days = CHART_DAYS.includes(Number(q.days)) ? Number(q.days) : 30;
  const role = ROLE_FILTERS.includes(q.role) ? q.role : null;
  const source = typeof q.source === 'string' && q.source.trim() && q.source.length <= 120 ? q.source.trim() : null;
  return { days, role, source };
}

// $1 days in the window (today included), $2 role, $3 traffic source.
const BASE = `
  today AS (SELECT (now() AT TIME ZONE 'UTC')::date AS d),
  s AS (SELECT *, coalesce(user_id::text, 'd:' || anonymous_device_id::text) AS actor,
               coalesce(nullif(utm_source, ''), referrer, '(direct)') AS src
          FROM analytics_sessions WHERE NOT is_internal AND NOT is_bot),
  e AS (SELECT ev.event_name, ev.properties, ev.client_timestamp, ev.session_id,
               coalesce(ev.user_id::text, 'd:' || ev.anonymous_device_id::text) AS actor,
               (ev.client_timestamp AT TIME ZONE 'UTC')::date AS day
          FROM analytics_events ev JOIN s USING (session_id)),
  answers AS (
    SELECT DISTINCT ON (actor) actor,
           CASE WHEN jsonb_typeof(properties->'lens_roles') = 'array' THEN properties->'lens_roles'
                ELSE '["skipped"]'::jsonb END AS roles
      FROM e
     WHERE jsonb_typeof(properties->'lens_roles') = 'array' OR properties->>'lens_roles' = 'skipped'
     ORDER BY actor, client_timestamp DESC),
  actors AS (SELECT actor, min(day) AS first_day FROM e GROUP BY actor),
  actor_role AS (
    SELECT a.actor, r.value #>> '{}' AS role FROM answers a, jsonb_array_elements(a.roles) r
    UNION ALL
    SELECT ac.actor, 'none' FROM actors ac WHERE NOT EXISTS (SELECT 1 FROM answers a WHERE a.actor = ac.actor)),
  first_src AS (SELECT DISTINCT ON (actor) actor, src FROM s ORDER BY actor, started_at),
  fa AS (SELECT ac.actor, ac.first_day FROM actors ac
          WHERE ($2::text IS NULL OR EXISTS (SELECT 1 FROM actor_role r WHERE r.actor = ac.actor AND r.role = $2))
            AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM first_src f WHERE f.actor = ac.actor AND f.src = $3))),
  win AS (SELECT d - ($1::int - 1) AS start, d AS stop FROM today),
  days AS (SELECT g::date AS day FROM win, generate_series(win.start, win.stop, interval '1 day') g)`;

const OPENED = `('record_clicked', 'record_detail_viewed')`;

async function charts(query, { days, role, source }) {
  const p = [days, role, source];
  const many = async (sql, params = p) => (await query(sql, params)).rows;

  const [growth, dauByRole, funnelRows, roleRows, retentionRows, sources, sourceOptions, ingestion, since] = await Promise.all([
    // 1. Active people per day, split into first-time and returning, and email sign-ups.
    many(`WITH ${BASE},
      ad AS (SELECT DISTINCT e.actor, e.day FROM e JOIN fa USING (actor) WHERE e.day >= (SELECT start FROM win))
      SELECT d.day::text AS day,
             count(ad.actor)::int AS dau,
             count(ad.actor) FILTER (WHERE fa.first_day = d.day)::int AS new_actors,
             count(ad.actor) FILTER (WHERE fa.first_day < d.day)::int AS returning,
             (SELECT count(*) FROM app_users u
               WHERE (u.created_at AT TIME ZONE 'UTC')::date = d.day
                 AND NOT EXISTS (SELECT 1 FROM analytics_internal_users iu WHERE iu.user_id = u.id)
                 AND (($2::text IS NULL AND $3::text IS NULL) OR EXISTS (SELECT 1 FROM fa WHERE fa.actor = u.id::text)))::int AS signups
        FROM days d LEFT JOIN ad ON ad.day = d.day LEFT JOIN fa ON fa.actor = ad.actor
       GROUP BY d.day ORDER BY d.day`),
    // 1b. The same daily actives, one line per pop-up answer.
    many(`WITH ${BASE},
      ad AS (SELECT DISTINCT e.actor, e.day FROM e JOIN fa USING (actor) WHERE e.day >= (SELECT start FROM win))
      SELECT ad.day::text AS day, r.role, count(DISTINCT ad.actor)::int AS dau
        FROM ad JOIN actor_role r USING (actor) GROUP BY 1, 2 ORDER BY 1, 2`),
    // 3. Funnel over people first seen in the window. Each step counts people who also did every step before it.
    many(`WITH ${BASE},
      c AS (SELECT actor, first_day FROM fa WHERE first_day >= (SELECT start FROM win)),
      f AS (SELECT c.actor,
                   bool_or(e.event_name = 'onboarding_completed' OR jsonb_typeof(e.properties->'lens_roles') = 'array') AS answered,
                   bool_or(e.event_name = 'search_executed') AS searched,
                   bool_or(e.event_name IN ${OPENED}) AS opened,
                   bool_or(e.event_name = ANY($4::text[])) AS intent,
                   bool_or(e.day > c.first_day) AS returned
              FROM c JOIN e USING (actor) GROUP BY c.actor)
      SELECT count(*)::int AS landed,
             count(*) FILTER (WHERE answered)::int AS answered,
             count(*) FILTER (WHERE answered AND searched)::int AS searched,
             count(*) FILTER (WHERE answered AND searched AND opened)::int AS opened,
             count(*) FILTER (WHERE answered AND searched AND opened AND intent)::int AS intent,
             count(*) FILTER (WHERE answered AND searched AND opened AND intent AND returned)::int AS returned,
             count(*) FILTER (WHERE searched)::int AS any_searched,
             count(*) FILTER (WHERE opened)::int AS any_opened,
             count(*) FILTER (WHERE intent)::int AS any_intent,
             count(*) FILTER (WHERE returned)::int AS any_returned
        FROM f`, [...p, HIGH_INTENT]),
    // 4. Each answer side by side (the role filter does not apply here; the source filter does).
    many(`WITH ${BASE},
      w AS (SELECT e.* FROM e JOIN fa USING (actor) WHERE e.day >= (SELECT start FROM win)),
      ws AS (SELECT s.* FROM s JOIN fa USING (actor) WHERE s.started_at >= (SELECT start FROM win)::timestamp AT TIME ZONE 'UTC')
      SELECT r.role,
             count(DISTINCT w.actor)::int AS actors,
             (count(*) FILTER (WHERE w.event_name = 'search_executed'))::int AS searches,
             (SELECT round(avg(ws.duration_seconds))::int FROM ws JOIN actor_role r2 USING (actor) WHERE r2.role = r.role) AS avg_session_seconds
        FROM w JOIN actor_role r USING (actor) GROUP BY r.role ORDER BY actors DESC`, [days, null, source]),
    // 4b. Day-7 retention per answer: first seen in the window and at least 7 days ago.
    many(`WITH ${BASE},
      c AS (SELECT fa.actor, fa.first_day FROM fa, today
             WHERE fa.first_day >= (SELECT start FROM win) AND fa.first_day <= today.d - 7)
      SELECT r.role, count(DISTINCT c.actor)::int AS eligible,
             count(DISTINCT c.actor) FILTER (WHERE EXISTS (SELECT 1 FROM e WHERE e.actor = c.actor AND e.day >= c.first_day + 7))::int AS returned
        FROM c JOIN actor_role r USING (actor) GROUP BY r.role`, [days, null, source]),
    // 5. Where visits came from, and how many of those people searched and opened a record (activated).
    many(`WITH ${BASE},
      ws AS (SELECT s.* FROM s JOIN fa USING (actor) WHERE s.started_at >= (SELECT start FROM win)::timestamp AT TIME ZONE 'UTC'),
      act AS (SELECT e.actor FROM e WHERE e.day >= (SELECT start FROM win) GROUP BY e.actor
               HAVING bool_or(e.event_name = 'search_executed') AND bool_or(e.event_name IN ${OPENED}))
      SELECT ws.src AS source, count(*)::int AS sessions, count(DISTINCT ws.actor)::int AS actors,
             count(DISTINCT ws.actor) FILTER (WHERE ws.actor IN (SELECT actor FROM act))::int AS activated
        FROM ws GROUP BY ws.src ORDER BY actors DESC, sessions DESC LIMIT 15`, [days, role, null]),
    many(`WITH ${BASE}
      SELECT src AS source, count(*)::int AS actors FROM first_src GROUP BY src ORDER BY actors DESC, src LIMIT 30`, [days, null, null]),
    // 2. Records we added per day: when WE first saw them, by region and by the stage they were in then.
    many(`WITH win AS (SELECT (now() AT TIME ZONE 'UTC')::date - ($1::int - 1) AS start),
      t AS (SELECT (start::timestamp AT TIME ZONE 'UTC') AS ts FROM win)
      SELECT (first_seen_at AT TIME ZONE 'UTC')::date::text AS day, source_area AS region,
             CASE WHEN first_seen_stage IN ('pre_application', 'submitted', 'in_review', 'corrections', 'approved') THEN 'permit_pending'
                  WHEN first_seen_stage IN ('issued', 'inspections', 'completed') THEN 'permit_issued'
                  ELSE 'permit_other' END AS stage,
             count(*)::int AS n
        FROM permits, t WHERE first_seen_at >= t.ts GROUP BY 1, 2, 3
      UNION ALL
      SELECT (first_seen_at AT TIME ZONE 'UTC')::date::text, source_area, 'pre_approval', count(*)::int
        FROM planning_cases, t WHERE first_seen_at >= t.ts GROUP BY 1, 2
      ORDER BY 1, 2, 3`, [days]),
    many(`SELECT (min(started_at) AT TIME ZONE 'UTC')::date::text AS day FROM analytics_sessions`, []),
  ]);

  const retention = new Map(retentionRows.map((r) => [r.role, r]));
  const roles = roleRows.map((r) => {
    const ret = retention.get(r.role) || { eligible: 0, returned: 0 };
    return {
      role: r.role,
      actors: r.actors,
      avgSessionSeconds: r.avg_session_seconds,
      searchesPerActor: r.actors ? Math.round((r.searches / r.actors) * 10) / 10 : null,
      d7Eligible: ret.eligible,
      d7Returned: ret.returned,
      d7Rate: ret.eligible ? ret.returned / ret.eligible : null,
    };
  });

  return {
    scope: { days, role, source },
    trackingSince: (since[0] && since[0].day) || null,
    growth,
    dauByRole,
    funnel: funnelRows[0] || {},
    roles,
    sources,
    sourceOptions,
    ingestion,
  };
}

module.exports = { charts, parseChartScope, CHART_DAYS, ROLE_FILTERS };
