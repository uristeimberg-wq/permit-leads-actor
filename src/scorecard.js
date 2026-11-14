// Data-quality scorecard metrics (ADR-23, docs/DATA_ENGINE_PLAN.md section 7).
// Each metric is one SQL query returning (market, numerator, denominator) or
// (market, value) rows; ingest/scorecard.js runs them and stores one row per
// market and day in scorecard_snapshots (migration 021). Day-30 and day-90
// targets live here next to the definition so the report can show the gap.
//
// Precision checks (hand-checked samples) are not here: a rate without its
// sample check is reported as a rate, never as "accuracy".

// v2 (2026-11-14): entity_anchored also counts Texas Comptroller business
// registrations (migration 024).
// v3 (2026-11-14): the four brief metrics that were missing: pre-issue
// capture, discovery latency (p50, p90), property enrichment depth and the
// duplicate rate. `lower: true` marks a metric where lower is better.
const METHOD_VERSION = 'scorecard-v3';

// Events we were watching for: the source's own date on or after the day of
// that source's first successful sync. Rows dated earlier came in the first
// load (or a backfill) and say nothing about how fast we see new records.
const WATCHED = `JOIN (SELECT s.slug, min(r.started_at)::date AS since FROM sync_runs r JOIN sources s ON s.id = r.source_id
                        WHERE r.status = 'succeeded' GROUP BY 1) w ON w.slug = p.source_area`;

const PERMITS = "p.filing_kind IS NULL";

const METRICS = {
  property_match: {
    unit: 'share', target30: 0.9, target90: 0.95,
    label: 'Filings linked to a parcel by official key',
    sql: `SELECT p.source_area AS market, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM permit_parcels x WHERE x.permit_id = p.id)) AS num, count(*) AS den
            FROM permits p GROUP BY 1`,
  },
  located: {
    unit: 'share', target30: 0.92, target90: 0.97,
    label: 'Filings with a map point',
    sql: `SELECT p.source_area AS market, count(l.permit_id) AS num, count(*) AS den
            FROM permits p LEFT JOIN permit_locations l ON l.permit_id = p.id GROUP BY 1`,
  },
  official_link: {
    unit: 'share', target30: 1, target90: 1,
    label: 'Filings with a link to the official record',
    sql: `SELECT p.source_area AS market,
                 count(*) FILTER (WHERE nullif(p.permit_url, '') IS NOT NULL
                   OR (to_regclass('public.permit_facts') IS NOT NULL AND EXISTS (SELECT 1 FROM permit_facts f WHERE f.permit_id = p.id AND f.record_url IS NOT NULL))) AS num,
                 count(*) AS den
            FROM permits p GROUP BY 1`,
  },
  contractor_resolved: {
    unit: 'share', target30: null, target90: 0.95,
    label: 'Permits resolved to a business entity',
    sql: `SELECT p.source_area AS market, count(pp.contractor_id) AS num, count(*) AS den
            FROM permits p LEFT JOIN permit_parties pp ON pp.permit_id = p.id WHERE ${PERMITS} GROUP BY 1`,
  },
  entity_anchored: {
    unit: 'share', target30: null, target90: 0.6,
    label: 'Business entities tied to a state licence or business registration',
    sql: `SELECT c.business_state AS market,
                 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contractor_registry_licences l WHERE l.contractor_id = c.id)
                                     OR EXISTS (SELECT 1 FROM contractor_registrations g WHERE g.contractor_id = c.id)) AS num, count(*) AS den
            FROM contractors c WHERE c.party_kind = 'business' GROUP BY 1`,
  },
  phone_coverage: {
    unit: 'share', target30: null, target90: 0.9,
    label: 'Business entities with a shown phone',
    sql: `SELECT c.business_state AS market,
                 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contact_points cp WHERE cp.contractor_id = c.id AND cp.kind = 'phone' AND cp.display_policy = 'show')) AS num, count(*) AS den
            FROM contractors c WHERE c.party_kind = 'business' GROUP BY 1`,
  },
  phone_corroborated: {
    unit: 'share', target30: 0.5, target90: 0.6,
    label: 'Shown phones corroborated (3+ permits, unshared)',
    sql: `SELECT c.business_state AS market, count(*) FILTER (WHERE cp.verification <> 'unverified') AS num, count(*) AS den
            FROM contact_points cp JOIN contractors c ON c.id = cp.contractor_id
           WHERE cp.kind = 'phone' AND cp.display_policy = 'show' GROUP BY 1`,
  },
  email_coverage: {
    unit: 'share', target30: null, target90: 0.5,
    label: 'Business entities with a business email (NC day-30 target 0.85)',
    sql: `SELECT c.business_state AS market,
                 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contact_points cp WHERE cp.contractor_id = c.id AND cp.kind = 'email' AND cp.display_policy = 'show')) AS num, count(*) AS den
            FROM contractors c WHERE c.party_kind = 'business' GROUP BY 1`,
  },
  application_linked: {
    unit: 'share', target30: 0.9, target90: 0.9,
    label: 'Applications older than 180 days linked to a permit',
    sql: `SELECT p.source_area AS market,
                 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM permit_links pl WHERE pl.from_permit_id = p.id)) AS num, count(*) AS den
            FROM permits p WHERE p.filing_kind IS NOT NULL AND p.submitted_on < current_date - 180 GROUP BY 1`,
  },
  trade_linked: {
    unit: 'share', target30: null, target90: null,
    label: 'Building jobs with a linked trade permit',
    sql: `SELECT p.source_area AS market,
                 count(DISTINCT pp.job_key) FILTER (WHERE EXISTS (SELECT 1 FROM permit_parties t WHERE t.job_key = pp.job_key AND t.trade IS NOT NULL AND t.permit_id <> pp.permit_id)) AS num,
                 count(DISTINCT pp.job_key) AS den
            FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id WHERE pp.is_building AND pp.job_key IS NOT NULL GROUP BY 1`,
  },
  history_days: {
    unit: 'days', target30: 30, target90: 90,
    label: 'Days since the first successful sync (gaps reported by sync_reliability)',
    sql: `SELECT s.slug AS market, (current_date - min(r.started_at)::date) AS value
            FROM sync_runs r JOIN sources s ON s.id = r.source_id WHERE r.status = 'succeeded' AND s.role = 'permits' GROUP BY 1`,
  },
  sync_days_missed_30: {
    unit: 'days', target30: 0, target90: 0, lower: true,
    label: 'Days in the last 30 (since first sync) without a successful run',
    sql: `WITH d AS (SELECT s.id, s.slug, generate_series(greatest(min(r.started_at)::date, current_date - 29), current_date - 1, '1 day')::date AS day
                       FROM sources s JOIN sync_runs r ON r.source_id = s.id WHERE s.enabled AND s.role = 'permits' GROUP BY s.id, s.slug)
          SELECT d.slug AS market, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM sync_runs r WHERE r.source_id = d.id AND r.status = 'succeeded' AND r.started_at::date = d.day)) AS value
            FROM d GROUP BY 1`,
  },
  sync_success_30: {
    unit: 'share', target30: 0.99, target90: 0.99,
    label: 'Sync runs that succeeded, last 30 days',
    sql: `SELECT s.slug AS market, count(*) FILTER (WHERE r.status = 'succeeded') AS num, count(*) AS den
            FROM sync_runs r JOIN sources s ON s.id = r.source_id WHERE r.started_at > now() - interval '30 days' AND r.status <> 'running' GROUP BY 1`,
  },
  pre_issue_capture: {
    unit: 'share', target30: null, target90: null,
    label: 'Building permits issued since we started watching that we saw first as an application or pre-issue record',
    sql: `SELECT p.source_area AS market,
                 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM permit_links pl JOIN permits a ON a.id = pl.from_permit_id
                                                 WHERE pl.to_permit_id = p.id AND a.first_seen_at < p.first_seen_at)
                                     OR p.first_seen_stage IN ('submitted', 'in_review', 'corrections', 'approved')) AS num,
                 count(*) AS den
            FROM permits p ${WATCHED}
           WHERE ${PERMITS} AND p.filed_date >= w.since
             AND EXISTS (SELECT 1 FROM permit_parties pp WHERE pp.permit_id = p.id AND pp.is_building)
           GROUP BY 1`,
  },
  discovery_days_p50: {
    unit: 'days', target30: null, target90: 1, lower: true,
    label: 'Days from the source date (issue, or submission for applications) to our first sight, median, events since we started watching',
    sql: `SELECT p.source_area AS market,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY (p.first_seen_at::date - coalesce(p.submitted_on, p.filed_date))) AS value
            FROM permits p ${WATCHED}
           WHERE coalesce(p.submitted_on, p.filed_date) >= w.since GROUP BY 1`,
  },
  discovery_days_p90: {
    unit: 'days', target30: null, target90: 2, lower: true,
    label: 'Same, 90th percentile (includes the source\'s own publication lag)',
    sql: `SELECT p.source_area AS market,
                 percentile_cont(0.9) WITHIN GROUP (ORDER BY (p.first_seen_at::date - coalesce(p.submitted_on, p.filed_date))) AS value
            FROM permits p ${WATCHED}
           WHERE coalesce(p.submitted_on, p.filed_date) >= w.since GROUP BY 1`,
  },
  enrichment_depth: {
    unit: 'count', target30: null, target90: 6,
    label: 'Median of 8 core property attributes present on linked parcels (land use, year built, living area, lot, floors, units, value, beds/baths)',
    sql: `SELECT market, percentile_cont(0.5) WITHIN GROUP (ORDER BY n) AS value FROM (
            SELECT DISTINCT ON (p.id) p.source_area AS market,
                   (c.land_use IS NOT NULL)::int + (c.year_built IS NOT NULL)::int + (c.heated_sqft IS NOT NULL)::int
                   + (c.lot_sqft IS NOT NULL)::int + (c.floors IS NOT NULL)::int + (c.units IS NOT NULL)::int
                   + (coalesce(c.assessed_value, c.land_value, c.improvement_value) IS NOT NULL)::int
                   + (coalesce(c.bedrooms, c.bathrooms) IS NOT NULL)::int AS n
              FROM permits p JOIN permit_parcels x ON x.permit_id = p.id JOIN parcels c ON c.id = x.parcel_id AND c.found
             ORDER BY p.id, c.id) t GROUP BY 1`,
  },
  duplicate_rate: {
    unit: 'share', target30: null, target90: 0.01, lower: true,
    label: 'Permits beyond the first sharing market, address, type and date (upper bound: units in one building are legitimate)',
    sql: `SELECT source_area AS market, coalesce(sum(c - 1), 0) AS num, sum(c) AS den FROM (
            SELECT p.source_area, count(*) AS c FROM permits p
             WHERE ${PERMITS} AND p.address IS NOT NULL AND p.filed_date IS NOT NULL
             GROUP BY 1, upper(regexp_replace(p.address, '[^A-Za-z0-9]', '', 'g')), p.permit_type, p.filed_date) g
           GROUP BY 1`,
  },
  open_pre_issue: {
    unit: 'count', target30: null, target90: null,
    label: 'Open applications not yet issued (what an issued-permit search cannot show)',
    sql: `SELECT p.source_area AS market, count(*) AS value FROM permits p
           WHERE p.lifecycle_stage IN ('submitted', 'in_review', 'corrections', 'approved')
             AND (p.filing_kind IS NOT NULL OR p.filed_date IS NULL)
             AND NOT EXISTS (SELECT 1 FROM permit_links pl WHERE pl.from_permit_id = p.id)
           GROUP BY 1`,
  },
};

/** One stored row from a query row, or null when there is nothing to measure. */
function toSnapshot(metric, row, day) {
  const m = METRICS[metric];
  if (!m || !row || row.market == null) return null;
  if (row.value !== undefined) {
    return { measured_on: day, market: String(row.market), metric, unit: m.unit, value: row.value == null ? null : Number(row.value), numerator: null, denominator: null };
  }
  const den = Number(row.den);
  if (!den) return null;
  const num = Number(row.num);
  return { measured_on: day, market: String(row.market), metric, unit: m.unit, value: num / den, numerator: num, denominator: den };
}

/** 'met' | 'below' | null against a target (higher is better, except days missed and `lower` metrics). */
function status(metric, value, target) {
  if (target == null || value == null) return null;
  const lower = metric === 'sync_days_missed_30' || Boolean(METRICS[metric] && METRICS[metric].lower);
  return lower ? (value <= target ? 'met' : 'below') : (value >= target ? 'met' : 'below');
}

module.exports = { METHOD_VERSION, METRICS, toSnapshot, status };
