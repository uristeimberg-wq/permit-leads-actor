// Queries behind the pilot overview (web/public/pilot/live/index.html): the
// first screen a salesperson sees. Every figure here is counted from stored
// permits; nothing is estimated or extrapolated.
//
// Privacy (CLAUDE.md rule 5, ADR-10): contractor names and phones go through
// the same rule as the other pilot screens (pilot_queries.publicContractor,
// display_policy = 'show'). Lists that rank companies leave individuals out,
// and say so on screen. Owner and applicant columns are never selected.
//
// Dates: permits.filed_date is the source's issue date for both pilot areas
// (src/sources.js maps Austin issue_date and Miami-Dade PermitIssuedDate).

const { query } = require('./index.js');
const { publicContractor, marketBaseline, sourceMeta, TRADES } = require('./pilot_queries.js');

const WEEKS = 26;
const RECENT_DAYS = 30;
const ACTIVE_DAYS = 90;

// Best displayable phone per contractor. Same ordering as pilot_queries
// BEST_PHONE: corroborated first, then the one seen on most permits.
const BEST_PHONE = `
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
             'value', cp.value, 'verification', cp.verification, 'seenOnPermits', cp.seen_on_permits,
             'sharedWithOtherContractors', cp.shared_with_other_contractors, 'lastSeenOn', cp.last_seen_on,
             'source', cp.source, 'sourceRef', cp.source_ref) AS phone
      FROM contact_points cp
     WHERE cp.contractor_id = c.id AND cp.kind = 'phone' AND cp.display_policy = 'show'
       AND cp.value NOT IN (SELECT value FROM suppressed_phones)
     ORDER BY (cp.verification <> 'unverified') DESC, cp.seen_on_permits DESC, cp.last_seen_on DESC NULLS LAST
     LIMIT 1) ph ON true`;

const num = (v) => (v == null ? null : Number(v));

/** Headline counts for the last 30 days, and who is active over 90. */
async function totals(source) {
  const { rows: [t] } = await query(`
    WITH p AS (
      SELECT p.id, p.filed_date, p.valuation, pp.is_building, pp.trade, pp.contractor_id, c.party_kind,
             EXISTS (SELECT 1 FROM contact_points cp WHERE cp.contractor_id = c.id AND cp.kind = 'phone'
                        AND cp.display_policy = 'show'
                        AND cp.value NOT IN (SELECT value FROM suppressed_phones)) AS has_phone
        FROM permits p
        LEFT JOIN permit_parties pp ON pp.permit_id = p.id AND pp.role = 'contractor'
        LEFT JOIN contractors c ON c.id = pp.contractor_id
       WHERE p.source_area = $1
    )
    SELECT count(*)::int AS permits,
           count(*) FILTER (WHERE filed_date > current_date - $2::int)::int AS permits_recent,
           count(*) FILTER (WHERE is_building AND filed_date > current_date - $2::int)::int AS bp_recent,
           count(*) FILTER (WHERE is_building AND filed_date >  current_date - 2 * $2::int
                                              AND filed_date <= current_date - $2::int)::int AS bp_prior,
           count(*) FILTER (WHERE trade IS NOT NULL AND filed_date > current_date - $2::int)::int AS tp_recent,
           count(*) FILTER (WHERE is_building AND filed_date > current_date - $2::int AND party_kind = 'business')::int AS bp_recent_business,
           count(*) FILTER (WHERE is_building AND filed_date > current_date - $2::int AND party_kind = 'business' AND has_phone)::int AS bp_recent_phone,
           count(*) FILTER (WHERE is_building AND filed_date > current_date - $2::int AND valuation IS NOT NULL)::int AS bp_recent_valued,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY valuation)
             FILTER (WHERE is_building AND filed_date > current_date - $2::int AND valuation IS NOT NULL) AS bp_recent_median_value,
           count(DISTINCT contractor_id) FILTER (WHERE is_building AND party_kind = 'business'
                                                   AND filed_date > current_date - $3::int)::int AS active_gcs,
           count(DISTINCT contractor_id) FILTER (WHERE trade IS NOT NULL AND party_kind = 'business'
                                                   AND filed_date > current_date - $3::int)::int AS active_subs,
           min(filed_date) AS first_on, max(filed_date) AS last_on
      FROM p`, [source, RECENT_DAYS, ACTIVE_DAYS]);
  return {
    recentDays: RECENT_DAYS,
    activeDays: ACTIVE_DAYS,
    permits: t.permits,
    permitsRecent: t.permits_recent,
    buildingRecent: t.bp_recent,
    buildingPrior: t.bp_prior,
    tradeRecent: t.tp_recent,
    buildingRecentWithBusinessGc: t.bp_recent_business,
    buildingRecentWithPhone: t.bp_recent_phone,
    buildingRecentValued: t.bp_recent_valued,
    buildingRecentMedianValue: t.bp_recent_median_value == null ? null : Math.round(Number(t.bp_recent_median_value)),
    activeGcs: t.active_gcs,
    activeSubs: t.active_subs,
    firstIssuedOn: t.first_on,
    lastIssuedOn: t.last_on,
  };
}

/**
 * Permits issued per week (Monday start) for the last 26 weeks. Weeks before
 * where our history starts come back as null, not zero: we hold no data there.
 * The current week is flagged partial (the source publishes with a lag).
 */
async function weekly(source) {
  const { rows } = await query(`
    WITH w AS (
      SELECT gs::date AS wk
        FROM generate_series(date_trunc('week', current_date) - make_interval(weeks => $2::int - 1),
                             date_trunc('week', current_date), interval '7 days') gs
    ),
    -- Where history really starts: the status-date window also brings in a few
    -- very old permits (see sourceMeta), so the 1st percentile, not the minimum.
    first AS (SELECT percentile_disc(0.01) WITHIN GROUP (ORDER BY filed_date) AS d
                FROM permits WHERE source_area = $1 AND filed_date IS NOT NULL)
    SELECT w.wk,
           (w.wk + 7 <= (SELECT d FROM first)) AS before_history,
           (w.wk = date_trunc('week', current_date)::date) AS partial,
           count(p.id)::int AS permits,
           count(p.id) FILTER (WHERE pp.is_building)::int AS building,
           count(p.id) FILTER (WHERE pp.trade IS NOT NULL)::int AS trade
      FROM w
      LEFT JOIN permits p ON p.source_area = $1 AND p.filed_date >= w.wk AND p.filed_date < w.wk + 7
      LEFT JOIN permit_parties pp ON pp.permit_id = p.id AND pp.role = 'contractor'
     GROUP BY w.wk ORDER BY w.wk`, [source, WEEKS]);
  return rows.map((r) => ({
    weekOf: r.wk,
    partial: r.partial,
    permits: r.before_history ? null : r.permits,
    building: r.before_history ? null : r.building,
    trade: r.before_history ? null : r.trade,
  }));
}

/** Building permits and all permits per ZIP (or city, with no ZIP) over 90 days. */
async function places(source) {
  const { rows } = await query(`
    SELECT p.zip, p.city, p.state, count(*)::int AS permits,
           count(*) FILTER (WHERE pp.is_building)::int AS building
      FROM permits p
      LEFT JOIN permit_parties pp ON pp.permit_id = p.id AND pp.role = 'contractor'
     WHERE p.source_area = $1 AND p.filed_date > current_date - $2::int
     GROUP BY p.zip, p.city, p.state`, [source, ACTIVE_DAYS]);
  return rows;
}

/**
 * The busiest GCs by building permits over 90 days, business names only, with
 * how many different subs they put on those jobs and a 13-week activity line.
 */
async function topGcs(source, limit = 10) {
  const { rows } = await query(`
    WITH bp AS (
      SELECT pp.contractor_id AS gc_id, pp.job_key, p.filed_date, p.zip
        FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id
       WHERE p.source_area = $1 AND pp.is_building AND pp.contractor_id IS NOT NULL
         AND p.filed_date > current_date - $2::int
    ),
    g AS (
      SELECT gc_id, count(*)::int AS jobs, max(filed_date) AS last_on,
             mode() WITHIN GROUP (ORDER BY zip) AS top_zip,
             count(DISTINCT zip)::int AS zips
        FROM bp GROUP BY gc_id
    ),
    subs AS (  -- a GC pulling its own trade permit is not a hire
      SELECT bp.gc_id, count(DISTINCT t.contractor_id)::int AS subs,
             count(DISTINCT bp.job_key)::int AS linked_jobs
        FROM bp
        JOIN permit_parties t ON t.job_key = bp.job_key AND t.trade IS NOT NULL
                             AND t.contractor_id IS NOT NULL AND t.contractor_id <> bp.gc_id
        JOIN permits p2 ON p2.id = t.permit_id AND p2.source_area = $1
       GROUP BY bp.gc_id
    )
    SELECT g.*, coalesce(s.subs, 0) AS subs, coalesce(s.linked_jobs, 0) AS linked_jobs,
           c.id, c.display_name, c.party_kind, ph.phone,
           (SELECT array_agg(coalesce(n, 0) ORDER BY wk)
              FROM (SELECT gs::date AS wk FROM generate_series(date_trunc('week', current_date) - interval '12 weeks',
                                                               date_trunc('week', current_date), interval '7 days') gs) w
              LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM bp b2
                                  WHERE b2.gc_id = g.gc_id AND b2.filed_date >= w.wk AND b2.filed_date < w.wk + 7) x ON true
           ) AS weeks
      FROM g
      JOIN contractors c ON c.id = g.gc_id
      LEFT JOIN subs s ON s.gc_id = g.gc_id
      ${BEST_PHONE}
     WHERE c.party_kind = 'business'
     ORDER BY g.jobs DESC, g.last_on DESC, g.gc_id
     LIMIT $3`, [source, ACTIVE_DAYS, limit]);
  return rows.map((r) => ({
    gc: publicContractor(r),
    jobs: r.jobs,
    lastJobOn: r.last_on,
    topZip: r.top_zip,
    zips: r.zips,
    subsHired: r.subs,
    linkedJobs: r.linked_jobs,
    weeks: r.weeks,
  }));
}

/** The latest building permits, with which trades have a permit on the job. */
async function recentBuilding(source, limit = 12) {
  const { rows } = await query(`
    SELECT p.id, p.permit_number, p.address, p.city, p.zip, p.permit_type, p.valuation, p.filed_date,
           p.status_raw, p.status_stage, pp.contractor_id,
           c.id AS c_id, c.display_name, c.party_kind,
           (SELECT coalesce(array_agg(DISTINCT t.trade), '{}')
              FROM permit_parties t JOIN permits p2 ON p2.id = t.permit_id AND p2.source_area = $1
             WHERE t.job_key = pp.job_key AND t.trade IS NOT NULL) AS trades
      FROM permit_parties pp
      JOIN permits p ON p.id = pp.permit_id
      LEFT JOIN contractors c ON c.id = pp.contractor_id
     WHERE pp.is_building AND p.source_area = $1 AND p.filed_date IS NOT NULL
     ORDER BY p.filed_date DESC, p.id DESC
     LIMIT $2`, [source, limit]);
  return rows.map((r) => ({
    id: Number(r.id),
    permitNumber: r.permit_number,
    address: r.address,
    city: r.city,
    zip: r.zip,
    permitType: r.permit_type,
    valuation: num(r.valuation),
    issuedOn: r.filed_date,
    statusRaw: r.status_raw,
    statusStage: r.status_stage,
    gc: r.c_id ? publicContractor({ id: r.c_id, display_name: r.display_name, party_kind: r.party_kind }) : null,
    trades: r.trades,
  }));
}

/** Repeat-hiring rate per trade over 12 months (the GC relationships finding). */
async function repeatHiring(source) {
  const out = {};
  await Promise.all(TRADES.map(async (trade) => {
    const b = await marketBaseline({ source, trade, months: 12, zips: null, me: null }, { topSubs: false });
    out[trade] = { rate: b.repeatRate, repeatHires: b.repeatHires, eligibleHires: b.eligibleHires, jobs: b.jobs, linkedJobs: b.linkedJobs };
  }));
  return out;
}

async function overview(source) {
  const [meta, t, weeks, placeRows, gcs, recent, repeat] = await Promise.all([
    sourceMeta(source), totals(source), weekly(source), places(source), topGcs(source), recentBuilding(source), repeatHiring(source),
  ]);
  return { meta, totals: t, weekly: weeks, placeRows, topGcs: gcs, recent, repeatHiring: repeat };
}

module.exports = { overview, totals, weekly, places, topGcs, recentBuilding, repeatHiring, WEEKS, RECENT_DAYS, ACTIVE_DAYS };
