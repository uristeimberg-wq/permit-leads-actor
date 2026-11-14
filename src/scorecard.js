// Data-quality scorecard metrics (ADR-23, docs/DATA_ENGINE_PLAN.md section 7).
// Each metric is one SQL query returning (market, numerator, denominator) or
// (market, value) rows; ingest/scorecard.js runs them and stores one row per
// market and day in scorecard_snapshots (migration 021). Day-30 and day-90
// targets live here next to the definition so the report can show the gap.
//
// Precision checks (hand-checked samples) are not here: a rate without its
// sample check is reported as a rate, never as "accuracy".

const METHOD_VERSION = 'scorecard-v1';

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
    label: 'Business entities tied to a state licence',
    sql: `SELECT c.business_state AS market,
                 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contractor_registry_licences l WHERE l.contractor_id = c.id)) AS num, count(*) AS den
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
    unit: 'days', target30: 0, target90: 0,
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

/** 'met' | 'below' | null against a target (higher is better, except days missed). */
function status(metric, value, target) {
  if (target == null || value == null) return null;
  return metric === 'sync_days_missed_30' ? (value <= target ? 'met' : 'below') : (value >= target ? 'met' : 'below');
}

module.exports = { METHOD_VERSION, METRICS, toSnapshot, status };
