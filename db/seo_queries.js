// Aggregates behind the public market pages (web/seo/, ADR-42).
//
// Counts only. No record, address, permit number, contractor, owner or phone
// leaves these queries: redistribution terms for Miami-Dade, Raleigh and the
// enrichment sources are still open (docs/COMPLIANCE.md), and contractor
// identity is only partly verified. Every figure is a count or a sum over
// stored rows, keyed on the source's own permit number (class A/B in
// docs/DATA_TRUST_AUDIT.md). Nothing is estimated; a figure a source does not
// publish comes back null and the page says so.
//
// Dates: windows end today (database date, UTC) and include it: "last 30
// days" is filed_date > current_date - 30. A date in the future (a typo on a
// record) is left out.

const { query } = require('./index.js');
const { SOURCES: CONFIG } = require('../src/sources.js');
const { marketSources } = require('../web/seo/markets.js');

// Before issue (src/lifecycle.js), as on the Early screen.
const EARLY_STAGES = ['pre_application', 'submitted', 'in_review', 'corrections', 'approved'];
const WEEKS = 12;
const TOP_TYPES = 12;

const num = (v) => (v == null ? null : Number(v));
const iso = (d) => (d == null ? null : (d instanceof Date ? d.toISOString() : String(d)));
const day = (d) => (d == null ? null : iso(d).slice(0, 10));

/** Each source's credit, licence note and last successful sync. */
async function sourceRows(slugs) {
  const { rows } = await query(`
    SELECT s.slug, s.enabled, s.attribution_text, s.endpoint_url, s.redistribution,
           (SELECT max(finished_at) FROM sync_runs r WHERE r.source_id = s.id AND r.status = 'succeeded') AS last_sync_at
      FROM sources s WHERE s.slug = ANY($1::text[]) ORDER BY s.slug`, [slugs]);
  return rows.map((r) => {
    const cfg = CONFIG[r.slug] || {};
    return {
      slug: r.slug,
      label: cfg.label || r.slug,
      enabled: r.enabled,
      attribution: r.attribution_text || null,
      endpoint: r.endpoint_url || null,
      redistribution: r.redistribution || null,
      lastSyncAt: iso(r.last_sync_at),
      publicationLag: (cfg.display && cfg.display.publicationLag) || null,
    };
  });
}

/** Permits issued in the last 30 and 90 days, with declared value. */
async function issued(slugs) {
  const { rows: [t] } = await query(`
    SELECT count(*) FILTER (WHERE filed_date > current_date - 30)::int AS issued_30,
           count(*)::int AS issued_90,
           count(*) FILTER (WHERE filed_date > current_date - 30 AND valuation IS NOT NULL)::int AS valued_30,
           count(*) FILTER (WHERE valuation IS NOT NULL)::int AS valued_90,
           -- A value repeated on several permits of one project counts once (ADR-36).
           sum(valuation) FILTER (WHERE filed_date > current_date - 30 AND valuation_first) AS value_30,
           sum(valuation) FILTER (WHERE valuation_first) AS value_90,
           (current_date - 29) AS from_30, (current_date - 89) AS from_90, current_date AS to_day,
           max(filed_date) AS latest_issue
      FROM permits
     WHERE source_area = ANY($1::text[]) AND filing_kind IS NULL
       AND filed_date > current_date - 90 AND filed_date <= current_date`, [slugs]);
  return {
    issued30: t.issued_30, issued90: t.issued_90,
    valued30: t.valued_30, valued90: t.valued_90,
    value30: t.valued_30 ? num(t.value_30) : null, value90: t.valued_90 ? num(t.value_90) : null,
    from30: day(t.from_30), from90: day(t.from_90), to: day(t.to_day),
    latestIssue: day(t.latest_issue),
  };
}

/** Where our history starts (1st percentile, as sourceMeta) and how much we hold. */
async function history(slugs) {
  const { rows: [h] } = await query(`
    SELECT count(*)::int AS records,
           percentile_disc(0.01) WITHIN GROUP (ORDER BY filed_date) FILTER (WHERE filed_date IS NOT NULL) AS from_day
      FROM permits WHERE source_area = ANY($1::text[]) AND filing_kind IS NULL`, [slugs]);
  return { records: h.records, from: day(h.from_day) };
}

/** Permits issued by the source's own permit type, 90 days, busiest first. */
async function byType(slugs) {
  const { rows } = await query(`
    SELECT nullif(trim(permit_type), '') AS type,
           count(*) FILTER (WHERE filed_date > current_date - 30)::int AS issued_30,
           count(*)::int AS issued_90,
           count(*) FILTER (WHERE valuation IS NOT NULL)::int AS valued_90,
           sum(valuation) FILTER (WHERE valuation_first) AS value_90
      FROM permits
     WHERE source_area = ANY($1::text[]) AND filing_kind IS NULL
       AND filed_date > current_date - 90 AND filed_date <= current_date
     GROUP BY 1 ORDER BY issued_90 DESC, type NULLS LAST`, [slugs]);
  const all = rows.map((r) => ({
    type: r.type, issued30: r.issued_30, issued90: r.issued_90, valued90: r.valued_90,
    value90: r.valued_90 ? num(r.value_90) : null,
  }));
  const top = all.slice(0, TOP_TYPES);
  const rest = all.slice(TOP_TYPES);
  return {
    types: top,
    other: rest.length ? {
      count: rest.length,
      issued30: rest.reduce((n, r) => n + r.issued30, 0),
      issued90: rest.reduce((n, r) => n + r.issued90, 0),
      valued90: rest.reduce((n, r) => n + r.valued90, 0),
      value90: rest.some((r) => r.value90 != null) ? rest.reduce((n, r) => n + (r.value90 || 0), 0) : null,
    } : null,
    typeCount: all.length,
  };
}

/** Permits issued per full week (Monday start), the last 12 weeks. Weeks before our history are null. */
async function weekly(slugs, historyFrom) {
  const { rows } = await query(`
    WITH w AS (
      SELECT gs::date AS wk
        FROM generate_series(date_trunc('week', current_date) - make_interval(weeks => $2::int),
                             date_trunc('week', current_date) - interval '7 days', interval '7 days') gs)
    SELECT w.wk, count(p.id)::int AS issued
      FROM w LEFT JOIN permits p ON p.source_area = ANY($1::text[]) AND p.filing_kind IS NULL
                                AND p.filed_date >= w.wk AND p.filed_date < w.wk + 7
     GROUP BY w.wk ORDER BY w.wk`, [slugs, WEEKS]);
  return rows.map((r) => {
    const weekOf = day(r.wk);
    const before = historyFrom && weekOf < historyFrom;
    return { weekOf, issued: before ? null : r.issued };
  });
}

/**
 * Applications filed before issue, by the date column each source uses, and
 * where they stand today (lifecycle_stage, the source's status mapped by the
 * reviewed table in src/sources.js).
 */
async function applications(apps) {
  if (!apps.length) return null;
  const parts = apps.map((a, i) => {
    // Column names come from web/seo/markets.js, never from a request.
    if (!['filed_date', 'submitted_on'].includes(a.dateColumn)) throw new Error(`bad dateColumn ${a.dateColumn}`);
    const kind = a.dateColumn === 'filed_date' ? 'AND filing_kind IS NOT NULL' : '';
    return `SELECT ${a.dateColumn} AS d, lifecycle_stage FROM permits
             WHERE source_area = $${i + 1} ${kind}
               AND ${a.dateColumn} > current_date - 90 AND ${a.dateColumn} <= current_date`;
  });
  const { rows } = await query(`
    WITH a AS (${parts.join(' UNION ALL ')})
    SELECT lifecycle_stage AS stage,
           count(*) FILTER (WHERE d > current_date - 30)::int AS filed_30,
           count(*)::int AS filed_90
      FROM a GROUP BY 1`, apps.map((a) => a.source));
  const sum = (k, pred = () => true) => rows.filter(pred).reduce((n, r) => n + r[k], 0);
  const early = (r) => EARLY_STAGES.includes(r.stage);
  return {
    filed30: sum('filed_30'), filed90: sum('filed_90'),
    beforeIssue30: sum('filed_30', early), beforeIssue90: sum('filed_90', early),
    stages: rows.map((r) => ({ stage: r.stage, filed30: r.filed_30, filed90: r.filed_90 })),
  };
}

/** Where permits issued in the last 90 days stand today. */
async function issuedStages(slugs) {
  const { rows } = await query(`
    SELECT lifecycle_stage AS stage,
           count(*) FILTER (WHERE filed_date > current_date - 30)::int AS issued_30,
           count(*)::int AS issued_90
      FROM permits
     WHERE source_area = ANY($1::text[]) AND filing_kind IS NULL
       AND filed_date > current_date - 90 AND filed_date <= current_date
     GROUP BY 1`, [slugs]);
  return rows.map((r) => ({ stage: r.stage, issued30: r.issued_30, issued90: r.issued_90 }));
}

/** Everything one market page shows. */
async function marketStats(market) {
  const [sources, iss, hist, types, apps, stages] = await Promise.all([
    sourceRows(marketSources(market)), issued(market.permits), history(market.permits),
    byType(market.permits), applications(market.applications), issuedStages(market.permits),
  ]);
  const weeks = await weekly(market.permits, hist.from);
  const syncs = sources.map((s) => s.lastSyncAt).filter(Boolean).sort();
  return {
    // The latest successful sync of any of the market's sources, and the
    // oldest: the page states both when they differ.
    lastSyncAt: syncs.length ? syncs[syncs.length - 1] : null,
    oldestSyncAt: syncs.length ? syncs[0] : null,
    enabled: sources.some((s) => s.enabled && market.permits.includes(s.slug)),
    sources,
    issued: iss,
    history: hist,
    types,
    weekly: weeks,
    applications: apps,
    issuedStages: stages,
    applicationSources: market.applications.map((a) => (CONFIG[a.source] && CONFIG[a.source].label) || a.source),
  };
}

/** Enabled permit sources with their credit and last sync, for /data-methodology and llms.txt. */
async function allPermitSources() {
  const { rows } = await query(`
    SELECT s.slug FROM sources s WHERE s.enabled AND s.role IN ('permits', 'planning', 'enrichment', 'inspections') ORDER BY s.slug`);
  return sourceRows(rows.map((r) => r.slug));
}

module.exports = { marketStats, allPermitSources, sourceRows, EARLY_STAGES, WEEKS, TOP_TYPES };
