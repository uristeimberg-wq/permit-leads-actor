// The query path behind the search API. One function builds the filtered
// permit query; the API layer only validates and forwards.
//
// Every user-supplied value goes in as a bound parameter. No string
// interpolation of input anywhere in this file.

const { query } = require('./index.js');
const { DEFAULT_STAGES, isValidStage } = require('../src/status.js');
const { redactContractor, isShownContractor, dropSuppressedPhone } = require('../src/privacy.js');
const { maskDescription } = require('../src/description_names.js');

// Names inside a description are masked for display (rule 5).
const maskRow = (r) => (r && r.work_description != null ? { ...r, work_description: maskDescription(r.work_description) } : r);

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

const SORTS = {
  newest: 'filed_date DESC NULLS LAST, id DESC',
  oldest: 'filed_date ASC NULLS LAST, id ASC',
  valuation: 'valuation DESC NULLS LAST, filed_date DESC NULLS LAST',
};

// owner, applicant_name and applicant_phone are stored but never selected for
// the API (src/privacy.js, CLAUDE.md rule 5). queries.test.js enforces it.
const RESULT_COLUMNS = `
  id, source_area, permit_number, jurisdiction, address, street, city, state, zip,
  permit_type, work_description, valuation,
  status, status_raw, status_stage,
  permit_url, filed_date, trade_scores, first_seen_at, last_seen_at,
  parcel_number, parcel_block, parcel_lot, parcel_subdivision,
  construction_type, other_construction_type,
  fees, fees_paid, fees_balance, inspections,
  contractor_name, contractor_phone, contractor_licence, contractor_trade,
  contractor_city`;

function clampInt(value, { min, max, fallback }) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Builds the WHERE clause from whichever filters were supplied.
 * Returns { sql, params } with 1-based positional placeholders.
 */
function buildWhere(filters, params = []) {
  const clauses = [];
  const add = (sql, value) => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };

  // Location. ZIP is the primary path; city/state/jurisdiction back the picker.
  if (filters.zip) add('zip = ?', String(filters.zip).trim());
  if (filters.city) add('upper(city) = upper(?)', String(filters.city).trim());
  if (filters.state) add('upper(state) = upper(?)', String(filters.state).trim());
  if (filters.jurisdiction) add('jurisdiction = ?', String(filters.jurisdiction).trim());
  if (filters.sourceArea) add('source_area = ?', String(filters.sourceArea).trim());

  // `areas` is a set of map pins rather than one place, so it has to OR
  // together ZIPs and cities: a viewport over Austin holds ZIPs, one over
  // Miami holds only a city, and a wide one holds both. Keys arrive as
  // `z:78704` / `c:MIAMI|FL`, which is why the two lists are parsed apart here
  // and recombined into a single clause.
  if (filters.areas) {
    const zips = [];
    const cities = [];
    for (const key of String(filters.areas).split(',')) {
      const value = key.slice(2).trim();
      if (!value) continue;
      if (key.startsWith('z:')) zips.push(value);
      else if (key.startsWith('c:')) cities.push(value.toUpperCase());
    }
    const parts = [];
    if (zips.length) { params.push(zips); parts.push(`zip = ANY($${params.length}::text[])`); }
    if (cities.length) {
      params.push(cities);
      parts.push(`upper(city) || '|' || upper(state) = ANY($${params.length}::text[])`);
    }
    // No recognised key means the viewport covers nothing we hold. Say that
    // with a false clause rather than silently returning the whole table.
    clauses.push(parts.length ? `(${parts.join(' OR ')})` : 'false');
  }

  // Date range over the portal's own filing date.
  if (filters.from) add('filed_date >= ?::date', filters.from);
  if (filters.to) add('filed_date <= ?::date', filters.to);

  // Lifecycle stage is the main status filter. Default is pending + approved:
  // finished and cancelled permits are work that can no longer be won, so they
  // are excluded unless explicitly asked for. `stage=any` opts out entirely.
  const requestedStages = filters.stage === 'any'
    ? null
    : (filters.stage
        ? String(filters.stage).split(',').map((v) => v.trim().toLowerCase()).filter(isValidStage)
        : DEFAULT_STAGES);

  if (requestedStages && requestedStages.length) {
    params.push(requestedStages);
    clauses.push(`status_stage = ANY($${params.length}::text[])`);
  }

  // Exact portal wording, for drilling into one specific status.
  if (filters.hasContact === 'true' || filters.hasContact === true) {
    // Only the phone the client can see counts as "has contact".
    clauses.push('contractor_phone IS NOT NULL');
  }
  if (filters.contractor) add('contractor_name ILIKE ?', `%${String(filters.contractor).trim()}%`);
  if (filters.statusRaw) add('lower(status_raw) = lower(?)', String(filters.statusRaw).trim());
  if (filters.status) add('status = ?', String(filters.status).trim().toLowerCase());
  if (filters.permitType) add('permit_type = ?', String(filters.permitType).trim());
  if (filters.minValuation != null && filters.minValuation !== '') {
    add('valuation >= ?', Number(filters.minValuation) || 0);
  }

  // Trade is an OPTIONAL refinement: absent it, every permit is returned.
  // Scores are precomputed at ingest, so this filters across the whole table.
  if (filters.trade) {
    params.push(String(filters.trade).trim().toLowerCase());
    const tradeParam = `$${params.length}`;
    params.push(clampInt(filters.minScore, { min: 0, max: 1000, fallback: 1 }));
    clauses.push(`COALESCE((trade_scores ->> ${tradeParam})::int, 0) >= $${params.length}`);
  }

  if (filters.q && String(filters.q).trim()) {
    add("search_tsv @@ plainto_tsquery('english', ?)", String(filters.q).trim());
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * @returns {Promise<{results: object[], total: number, page: number, pageSize: number}>}
 */
async function searchPermits(filters = {}) {
  const page = clampInt(filters.page, { min: 1, max: 100000, fallback: 1 });
  const pageSize = clampInt(filters.pageSize, { min: 1, max: MAX_PAGE_SIZE, fallback: DEFAULT_PAGE_SIZE });
  const orderBy = SORTS[filters.sort] || SORTS.newest;

  const { sql: where, params } = buildWhere(filters);

  // Stage counts for the sidebar. These must respect every OTHER active filter
  // but not the stage filter itself — otherwise checking "Waiting" would show
  // "Approved 0", which is nonsense. `stage: 'any'` is buildWhere's existing
  // opt-out for the stage clause, so this reuses the filter logic rather than
  // reimplementing it.
  const facet = buildWhere({ ...filters, stage: 'any' });

  const countSql = `SELECT count(*)::int AS total FROM permits ${where}`;
  const rowsSql = `
    SELECT ${RESULT_COLUMNS}
      FROM permits
      ${where}
     ORDER BY ${orderBy}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  const facetSql = `
    SELECT status_stage, count(*)::int AS permits
      FROM permits
      ${facet.sql}
     GROUP BY status_stage`;

  const [counted, rows, stageCounts] = await Promise.all([
    query(countSql, params),
    query(rowsSql, [...params, pageSize, (page - 1) * pageSize]),
    query(facetSql, facet.params),
  ]);
  const suppressed = await suppressedPhones();

  return {
    results: rows.rows.map((r) => maskRow(dropSuppressedPhone(redactContractor(r), suppressed))),
    total: counted.rows[0].total,
    page,
    pageSize,
    facets: {
      stages: Object.fromEntries(stageCounts.rows.map((r) => [r.status_stage, r.permits])),
    },
  };
}

/**
 * Permit counts per place, for the map. Grouped by ZIP where the source gives
 * one and by city otherwise — Miami-Dade publishes no property ZIP, so its
 * ~2,900 permits would be invisible on a ZIP-only map.
 *
 * Coordinates are NOT stored per permit (the schema has no lat/lng), so the
 * API layer attaches a centroid per place. Pins are therefore area-accurate,
 * not address-accurate.
 */
async function mapClusters(filters = {}) {
  const { sql: where, params } = buildWhere(filters);
  const { rows } = await query(`
    SELECT zip, city, state, count(*)::int AS permits,
           count(*) FILTER (WHERE status_stage = 'pending')::int AS pending
      FROM permits
      ${where}
     GROUP BY zip, city, state`, params);
  return rows;
}

/**
 * Which places we actually hold data for. This is what lets the UI distinguish
 * "no permits matched your filters" from "we don't cover your area yet" —
 * showing an empty list for an uncovered ZIP would be actively misleading.
 */
async function listAreas() {
  const [zips, cities, jurisdictions] = await Promise.all([
    // city/state ride along so the picker can group ZIPs by the place they are
    // in — "78704 · Austin, TX" rather than a bare five-digit list.
    query(`SELECT zip, min(city) AS city, min(state) AS state,
                  count(*)::int AS permits, max(filed_date) AS latest
             FROM permits WHERE zip IS NOT NULL
            GROUP BY zip ORDER BY zip`),
    // without_zip is what makes a city worth offering in its own right: those
    // permits are unreachable by postal code, because the source never gave one.
    query(`SELECT city, state, count(*)::int AS permits,
                  count(*) FILTER (WHERE zip IS NULL)::int AS without_zip
             FROM permits WHERE city IS NOT NULL
            GROUP BY city, state ORDER BY state, city`),
    query(`SELECT jurisdiction, count(*)::int AS permits
             FROM permits WHERE jurisdiction IS NOT NULL
            GROUP BY jurisdiction ORDER BY jurisdiction`),
  ]);
  return { zips: zips.rows, cities: cities.rows, jurisdictions: jurisdictions.rows };
}

async function isZipCovered(zip) {
  const { rows } = await query('SELECT 1 FROM permits WHERE zip = $1 LIMIT 1', [String(zip).trim()]);
  return rows.length > 0;
}

/** Distinct values for the filter dropdowns, so the UI never offers a dead option. */
async function listFilterOptions() {
  const [types, stages, rawStatuses] = await Promise.all([
    query(`SELECT permit_type, count(*)::int AS permits FROM permits
            WHERE permit_type IS NOT NULL GROUP BY permit_type ORDER BY permits DESC`),
    query(`SELECT status_stage, count(*)::int AS permits FROM permits
            WHERE status_stage IS NOT NULL GROUP BY status_stage ORDER BY permits DESC`),
    query(`SELECT status_raw, status_stage, count(*)::int AS permits FROM permits
            WHERE status_raw IS NOT NULL GROUP BY status_raw, status_stage ORDER BY permits DESC`),
  ]);
  return { permitTypes: types.rows, stages: stages.rows, rawStatuses: rawStatuses.rows };
}

/* Portals use these in the contractor column to mean "no contractor" — an
 * owner-builder doing the work themselves. Treating them as companies would
 * invent a firm with a thousand jobs across three states. */
const NON_CONTRACTORS = ['OWNER', 'OWNER/BUILDER', 'OWNER BUILDER', 'SELF', 'HOMEOWNER', 'N/A', 'NONE', 'TBD'];

const isRealContractor = (name) =>
  Boolean(name) && !NON_CONTRACTORS.includes(String(name).trim().toUpperCase());

/** Contractor names matching a query, busiest first — backs the name picker. */
async function searchContractors(q, limit = 20) {
  const term = String(q || '').trim();
  const { rows } = await query(`
    SELECT contractor_name AS name,
           count(*)::int AS permits,
           max(filed_date) AS last_filed
      FROM permits
     WHERE contractor_name IS NOT NULL
       AND upper(contractor_name) <> ALL($1::text[])
       ${term ? 'AND contractor_name ILIKE $3' : ''}
     GROUP BY contractor_name
     ORDER BY permits DESC
     LIMIT $2`,
    // Over-fetch, then drop names that look like people (rule 5).
    term ? [NON_CONTRACTORS, limit * 3, `%${term}%`] : [NON_CONTRACTORS, limit * 3]);
  return rows.filter((r) => isShownContractor(r.name)).slice(0, limit);
}

/**
 * Everything one contractor has pulled, across every area we hold — the point
 * being that a permit is a single job whereas this is a track record: how much
 * they build, where, of what, and whether they are still active.
 *
 * Matched on the exact stored name. Portals do not issue contractor IDs we can
 * rely on across sources, so two spellings of one firm are two records here;
 * that limit is real and is not papered over with fuzzy joining.
 */
async function getContractorHistory(name) {
  const key = String(name || '').trim();
  if (!key || !isShownContractor(key)) return null; // people are not profiled (rule 5)

  // Portals record the same firm under several spellings — "Radiant Plumbing
  // and Air Conditioning" and "Radiant Plumbing & AC" are one company with 106
  // and 49 permits. Rather than fuzzy-merge them (which would silently combine
  // two genuinely different firms sooner or later), the near-matches are
  // returned so the UI can offer them and the user decides.
  const firstToken = key.split(/[\s,.&]+/).filter(Boolean)[0] || key;

  const [summary, areas, types, contact, recent, similar] = await Promise.all([
    query(`
      SELECT count(*)::int AS permits,
             count(*) FILTER (WHERE status_stage = 'pending')::int   AS pending,
             count(*) FILTER (WHERE status_stage = 'approved')::int  AS approved,
             count(*) FILTER (WHERE status_stage = 'finished')::int  AS finished,
             count(*) FILTER (WHERE status_stage = 'cancelled')::int AS cancelled,
             min(filed_date) AS first_filed,
             max(filed_date) AS last_filed,
             sum(valuation)::numeric AS total_valuation,
             count(*) FILTER (WHERE valuation > 0)::int AS valued
        FROM permits WHERE contractor_name = $1`, [key]),
    query(`
      SELECT coalesce(zip, city) AS area, state, count(*)::int AS permits
        FROM permits WHERE contractor_name = $1 AND coalesce(zip, city) IS NOT NULL
       GROUP BY area, state ORDER BY permits DESC LIMIT 8`, [key]),
    query(`
      SELECT permit_type, count(*)::int AS permits
        FROM permits WHERE contractor_name = $1 AND permit_type IS NOT NULL
       GROUP BY permit_type ORDER BY permits DESC LIMIT 6`, [key]),
    query(`
      SELECT max(contractor_phone) AS phone, max(contractor_licence) AS licence,
             max(contractor_city) AS city, max(contractor_trade) AS trade
        FROM permits WHERE contractor_name = $1`, [key]),
    query(`
      SELECT id, address, city, zip, permit_type, work_description, valuation,
             status_raw, status_stage, filed_date, permit_number
        FROM permits WHERE contractor_name = $1
       ORDER BY filed_date DESC NULLS LAST, id DESC LIMIT 25`, [key]),
    query(`
      SELECT contractor_name AS name, count(*)::int AS permits
        FROM permits
       WHERE contractor_name IS NOT NULL
         AND contractor_name <> $1
         AND contractor_name ILIKE $2
       GROUP BY contractor_name ORDER BY permits DESC LIMIT 5`, [key, `${firstToken}%`]),
  ]);

  if (!summary.rows[0].permits) return null;
  return {
    name: key,
    ...summary.rows[0],
    ...dropSuppressedPhone(contact.rows[0], await suppressedPhones(), 'phone'),
    areas: areas.rows,
    permitTypes: types.rows,
    recent: recent.rows.map(maskRow),
    similar: similar.rows.filter((r) => isShownContractor(r.name)),
  };
}

/** One permit, with everything we hold — backs the in-app detail view. */
async function getPermit(id) {
  const { rows } = await query(`SELECT ${RESULT_COLUMNS} FROM permits WHERE id = $1`, [Number(id)]);
  return rows[0] ? maskRow(dropSuppressedPhone(redactContractor(rows[0]), await suppressedPhones())) : null;
}

/** Phones under a removal request (009_suppressions.sql), as a Set of E.164. */
async function suppressedPhones() {
  const { rows } = await query('SELECT value FROM suppressed_phones');
  return new Set(rows.map((r) => r.value));
}

/** Freshness: when each source last ingested successfully. */
async function getFreshness() {
  const { rows } = await query(`
    SELECT DISTINCT ON (source_area)
           source_area, started_at, finished_at, permits_seen, permits_new, error
      FROM ingest_runs
     ORDER BY source_area, started_at DESC`);
  return rows;
}

module.exports = {
  RESULT_COLUMNS,
  searchPermits, listAreas, listFilterOptions, getPermit, isZipCovered, getFreshness,
  mapClusters, searchContractors, getContractorHistory, isRealContractor,
  buildWhere, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE,
};
