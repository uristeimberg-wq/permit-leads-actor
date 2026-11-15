// The query path behind the search API. One function builds the filtered
// permit query; the API layer only validates and forwards.
//
// Every user-supplied value goes in as a bound parameter. No string
// interpolation of input anywhere in this file.

const { query } = require('./index.js');
const { DEFAULT_STAGES, isValidStage } = require('../src/status.js');
const { redactContractor, isShownContractor, dropSuppressedPhone } = require('../src/privacy.js');
const { maskDescription } = require('../src/description_names.js');
const { SOURCES: SOURCE_CONFIG } = require('../src/sources.js');
const { locationSql, valueRepeatsSql } = require('../src/display_policy.js');

// Names inside a description are masked for display (rule 5).
const maskRow = (r) => (r && r.work_description != null ? { ...r, work_description: maskDescription(r.work_description) } : r);

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

const SORTS = {
  newest: 'filed_date DESC NULLS LAST, id DESC',
  oldest: 'filed_date ASC NULLS LAST, id ASC',
  // Highest declared value first. A $1 placeholder (2,444 Austin permits) and a
  // value of $1 billion or more (13 permits, e.g. five at $8.1B on one Austin
  // lot) are not real job values, so they sort with the missing ones, last.
  valuation: 'CASE WHEN valuation > 1 AND valuation < 1000000000 THEN valuation END DESC NULLS LAST, filed_date DESC NULLS LAST, id DESC',
};

// owner, applicant_name and applicant_phone are stored but never selected for
// the API (src/privacy.js, CLAUDE.md rule 5). queries.test.js enforces it.
const RESULT_COLUMNS = `
  id, source_area, permit_number, jurisdiction, address, street, city, state, zip,
  permit_type, work_description, valuation,
  status, status_raw, status_stage, lifecycle_stage, filing_kind, stage_since,
  permit_url, filed_date, trade_scores, first_seen_at, last_seen_at,
  parcel_number, parcel_block, parcel_lot, parcel_subdivision,
  construction_type, other_construction_type,
  fees, fees_paid, fees_balance, inspections,
  contractor_name, contractor_phone, contractor_licence, contractor_trade,
  contractor_city`;

// The job site's located point (015_permit_locations.sql), with how it was
// found, so the map can say "this job site" only when we hold one. NULL when
// the permit is not located; the UI then falls back to its area's centre.
// How many permits of this source carry the same declared value (ADR-35).
const VALUE_REPEATS = () => `${valueRepeatsSql('permits')} AS valuation_repeats`;

const LOCATION_COLUMN = () => `(
  SELECT json_build_object('lat', l.lat, 'lng', l.lng, 'method', l.method, 'quality', l.quality)
    FROM permit_locations l WHERE l.permit_id = permits.id AND ${locationSql('l')}) AS location`;

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
    const states = [];
    for (const key of String(filters.areas).split(',')) {
      const value = key.slice(2).trim();
      if (!value) continue;
      if (key.startsWith('z:')) zips.push(value);
      else if (key.startsWith('c:')) cities.push(value.toUpperCase());
      // `s:TX`: a whole market (the Leads screen's broad areas). It reaches the
      // sources that publish no city or ZIP (City of Miami, Austin plan review).
      else if (key.startsWith('s:')) states.push(value.toUpperCase());
    }
    const parts = [];
    if (zips.length) { params.push(zips); parts.push(`zip = ANY($${params.length}::text[])`); }
    if (cities.length) {
      params.push(cities);
      parts.push(`upper(city) || '|' || upper(state) = ANY($${params.length}::text[])`);
    }
    if (states.length) { params.push(states); parts.push(`upper(state) = ANY($${params.length}::text[])`); }
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
  // One company (the resolver's ids; a merged row in the Contractors tab can
  // stand for several): the permits it is the contractor on.
  if (filters.contractorIds) {
    const ids = String(filters.contractorIds).split(',').map((v) => Number(v)).filter(Number.isSafeInteger).slice(0, 50);
    params.push(ids);
    clauses.push(`EXISTS (SELECT 1 FROM permit_parties pp WHERE pp.permit_id = permits.id AND pp.role = 'contractor'
                    AND pp.contractor_id = ANY($${params.length}::bigint[]))`);
  }
  if (filters.statusRaw) add('lower(status_raw) = lower(?)', String(filters.statusRaw).trim());
  if (filters.status) add('status = ?', String(filters.status).trim().toLowerCase());
  // One type, or several separated by `|` (some raw types contain commas, none
  // contain a pipe). A single value, as in old links, behaves as before.
  if (filters.permitType) {
    const types = String(filters.permitType).split('|').map((t) => t.trim()).filter(Boolean);
    if (types.length === 1) add('permit_type = ?', types[0]);
    else if (types.length > 1) { params.push(types); clauses.push(`permit_type = ANY($${params.length}::text[])`); }
  }
  // Owner-builder: the homeowner pulled the permit, so the contractor field
  // holds an owner marker. The SQL twin of src/contractors.js isOwnerBuilder,
  // except a missing name: "no contractor listed" is not "the homeowner".
  // Only the marker is shown; the owner's name and phone never are (rule 5).
  if (filters.ownerBuilder === 'true' || filters.ownerBuilder === true) {
    params.push(NON_CONTRACTORS);
    clauses.push(`(contractor_name IS NOT NULL AND (upper(trim(contractor_name)) = ANY($${params.length}::text[])
      OR contractor_name ~* '^\\s*owner\\M' OR contractor_name ~* '\\mhomeowner\\M'))`);
  }
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
    SELECT ${RESULT_COLUMNS}, ${VALUE_REPEATS()}, ${LOCATION_COLUMN()}
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
 * Where each ZIP's and each city's permits actually are: the median of their
 * located job sites. Computed over the whole table, so it is cached in-process
 * for CENTROID_TTL_MS (locations change once a day, with the sync). A failure
 * returns empty maps, and placement falls back to data/area-coords.json.
 */
const CENTROID_TTL_MS = 6 * 3600 * 1000;
let centroidCache = null;

const EMPTY_CENTROIDS = Object.freeze({ zips: new Map(), cities: new Map() });

/**
 * @param {{maxWaitMs?: number}} opts  when the cache is cold, wait at most this
 *   long; past it, answer from the area file (empty maps) while the query
 *   finishes and fills the cache for the next request. Keeps the search page's
 *   first load after a deploy from waiting on a whole-table aggregate.
 */
async function areaCentroids({ now = Date.now(), maxWaitMs = Infinity } = {}) {
  const fresh = centroidCache && now - centroidCache.at < CENTROID_TTL_MS;
  if (!fresh) refreshCentroids(now);
  if (!Number.isFinite(maxWaitMs)) return centroidCache.value;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(EMPTY_CENTROIDS), maxWaitMs); });
  try {
    return await Promise.race([centroidCache.value, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function refreshCentroids(now) {
  const pending = (async () => {
    const { rows } = await query(`
      SELECT 'z' AS kind, p.zip AS key,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY l.lat) AS lat,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY l.lng) AS lng,
             count(*)::int AS located
        FROM permits p JOIN permit_locations l ON l.permit_id = p.id
       WHERE p.zip IS NOT NULL
       GROUP BY p.zip
      UNION ALL
      SELECT 'c', upper(p.city) || '|' || upper(p.state),
             percentile_cont(0.5) WITHIN GROUP (ORDER BY l.lat),
             percentile_cont(0.5) WITHIN GROUP (ORDER BY l.lng),
             count(*)::int
        FROM permits p JOIN permit_locations l ON l.permit_id = p.id
       WHERE p.city IS NOT NULL AND p.state IS NOT NULL
       GROUP BY upper(p.city), upper(p.state)`);
    const value = { zips: new Map(), cities: new Map() };
    for (const r of rows) {
      (r.kind === 'z' ? value.zips : value.cities).set(r.key, { lat: Number(r.lat), lng: Number(r.lng), located: r.located });
    }
    return value;
  })();
  // Concurrent callers share one query rather than each starting their own.
  // A failure answers from the area file and is retried on the next request.
  const value = pending.catch((err) => {
    console.error('areaCentroids failed; using the area file only:', err.message);
    centroidCache = null;
    return EMPTY_CENTROIDS;
  });
  centroidCache = { at: now, value };
}

const MAX_POINTS = 1000;

/**
 * Located job sites inside a map viewport, for the current filters. Asked for
 * only when the map is zoomed in to neighbourhood level, so the box is small.
 * `inView` counts every located permit in the box, so the UI can say when it
 * shows fewer than that.
 */
async function mapPoints(filters, bbox) {
  const { sql: where, params } = buildWhere(filters);
  const n = params.length;
  const box = [bbox.south, bbox.north, bbox.west, bbox.east];
  const from = `FROM permits JOIN permit_locations l ON l.permit_id = permits.id AND ${locationSql('l')}
    ${where ? `${where} AND` : 'WHERE'} l.lat BETWEEN $${n + 1} AND $${n + 2} AND l.lng BETWEEN $${n + 3} AND $${n + 4}`;
  const [pts, total] = await Promise.all([
    query(`
      SELECT permits.id, l.lat, l.lng, l.method, l.quality, permits.status_stage, permits.address
        ${from}
       ORDER BY permits.filed_date DESC NULLS LAST, permits.id DESC
       LIMIT $${n + 5}`, [...params, ...box, MAX_POINTS]),
    query(`SELECT count(*)::int AS n ${from}`, [...params, ...box]),
  ]);
  return {
    points: pts.rows.map((r) => ({ id: Number(r.id), lat: r.lat, lng: r.lng, method: r.method, quality: r.quality,
      stage: r.status_stage, address: r.address })),
    inView: total.rows[0].n,
    limit: MAX_POINTS,
  };
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
  const { rows } = await query(`SELECT ${RESULT_COLUMNS}, ${VALUE_REPEATS()}, ${LOCATION_COLUMN()} FROM permits WHERE id = $1`, [Number(id)]);
  return rows[0] ? maskRow(dropSuppressedPhone(redactContractor(rows[0]), await suppressedPhones())) : null;
}

// ── Projects (web/projects.js groups these rows) ────────────────────────────
//
// Each permit row carries its job link from the resolver (permit_parties: the
// Austin permit-number base, the Miami-Dade master permit, the City of Miami
// application, the Raleigh parcel PIN) so permits can be grouped into projects
// in the web layer. Same columns and redaction as the search (rule 5).
const JOB_COLUMN = `(
  SELECT json_build_object('jobKey', pp.job_key, 'isBuilding', pp.is_building, 'trade', pp.trade, 'contractorId', pp.contractor_id)
    FROM permit_parties pp WHERE pp.permit_id = permits.id AND pp.role = 'contractor' LIMIT 1) AS job`;
// The street part of the address with any "BLDG ..." tail removed, upper-cased:
// "2501 BRYAN ST BLDG 3, AUSTIN TX" -> "2501 BRYAN ST". A bare "UNIT 120"
// stays, as it is usually a separate tenant. Mirrors web/projects.js addressKey.
const ADDRESS_KEY_SQL = (t = 'permits') => `regexp_replace(regexp_replace(upper(trim(split_part(${t}.address, ',', 1))), '\\s+', ' ', 'g'), '\\s+(BLDG|BUILDING)\\M.*$', '')`;
const PROJECT_ROW_CAP = 15000;

/**
 * The permits matching `filters`, newest first, up to `limit`, for grouping
 * into projects. Also the total matched (so a capped answer can say so) and
 * the stage counts for the sidebar, as searchPermits gives.
 */
async function projectRows(filters = {}, { limit = PROJECT_ROW_CAP } = {}) {
  const { sql: where, params } = buildWhere(filters);
  const facet = buildWhere({ ...filters, stage: 'any' });
  const [rows, counted, stageCounts, suppressed] = await Promise.all([
    query(`SELECT ${RESULT_COLUMNS}, ${VALUE_REPEATS()}, ${JOB_COLUMN} FROM permits ${where}
            ORDER BY filed_date DESC NULLS LAST, id DESC LIMIT $${params.length + 1}`, [...params, limit]),
    query(`SELECT count(*)::int AS total FROM permits ${where}`, params),
    query(`SELECT status_stage, count(*)::int AS permits FROM permits ${facet.sql} GROUP BY status_stage`, facet.params),
    suppressedPhones(),
  ]);
  return {
    rows: rows.rows.map((r) => maskRow(dropSuppressedPhone(redactContractor(r), suppressed))),
    total: counted.rows[0].total,
    capped: counted.rows[0].total > limit,
    facets: { stages: Object.fromEntries(stageCounts.rows.map((r) => [r.status_stage, r.permits])) },
  };
}

/**
 * Every permit that may belong to the same project as `permitId`, whatever
 * the filters: the same job link, the same address key, a "Ref: <number> BP"
 * pointing either way. web/projects.js decides which of them really join.
 */
async function projectCandidates(permitId, { limit = 400 } = {}) {
  const id = Number(permitId);
  if (!Number.isSafeInteger(id)) return [];
  // A union of narrow lookups, each on an index or one ZIP/city, rather than
  // one OR across the table (which scanned every description: ~1 s).
  const sameArea = (p) => `((t.t_zip IS NOT NULL AND ${p}.zip = t.t_zip)
      OR (t.t_zip IS NULL AND ${p}.state = t.t_state AND upper(${p}.city) = t.t_city))`;
  const { rows } = await query(`
    WITH t AS (
      SELECT p.id AS t_id, p.source_area AS t_source, p.work_description AS t_desc,
             ${ADDRESS_KEY_SQL('p')} AS t_ak, p.zip AS t_zip, p.state AS t_state, upper(p.city) AS t_city,
             (SELECT pp.job_key FROM permit_parties pp WHERE pp.permit_id = p.id AND pp.role = 'contractor' LIMIT 1) AS t_job
        FROM permits p WHERE p.id = $1),
    ids AS (
      SELECT t.t_id AS id FROM t
      UNION
      SELECT pp.permit_id FROM t JOIN permit_parties pp ON pp.job_key = t.t_job AND pp.role = 'contractor'
        JOIN permits q ON q.id = pp.permit_id AND q.source_area = t.t_source
      UNION
      SELECT q.id FROM t JOIN permits q ON ${sameArea('q')}
       WHERE t.t_ak <> '' AND ${ADDRESS_KEY_SQL('q')} = t.t_ak
      UNION
      SELECT q.id FROM t JOIN permits q ON ${sameArea('q')}
       WHERE t.t_job IS NOT NULL AND q.work_description ILIKE '%' || t.t_job || ' BP%'
      UNION
      SELECT q.id FROM t JOIN permits q ON q.source_area = t.t_source
        AND q.permit_number = substring(t.t_desc from '(?i)ref\\.?\\s*:?\\s*#?\\s*(\\d{4}-\\d{5,6}\\s*BP)'))
    SELECT ${RESULT_COLUMNS}, ${VALUE_REPEATS()}, ${JOB_COLUMN}
      FROM permits WHERE id IN (SELECT id FROM ids)
     ORDER BY filed_date ASC NULLS LAST, id
     LIMIT $2`, [id, limit]);
  const suppressed = await suppressedPhones();
  return rows.map((r) => maskRow(dropSuppressedPhone(redactContractor(r), suppressed)));
}

// ── Contractors in an area (the Contractors tab, web/contractors.js) ─────────
/**
 * One row per business contractor on the permits matching `filters`: permits,
 * active (pending or approved) permits, the active declared value (a value
 * repeated at one address counted once; $1 and $1B+ left out) and the latest
 * filing. Individuals are never listed (rule 5). All rows: web/contractors.js
 * merges duplicate names, sorts and pages.
 */
async function contractorsInFilters(filters = {}) {
  const { sql: where, params } = buildWhere(filters);
  const { rows } = await query(`
    WITH p AS (SELECT permits.id, permits.status_stage, permits.valuation, permits.filed_date,
                      ${ADDRESS_KEY_SQL('permits')} AS ak FROM permits ${where}),
    cp AS (SELECT pp.contractor_id, p.* FROM p JOIN permit_parties pp ON pp.permit_id = p.id AND pp.role = 'contractor'),
    v AS (SELECT contractor_id, sum(valuation) AS active_value FROM (
            SELECT DISTINCT contractor_id, ak, valuation FROM cp
             WHERE status_stage IN ('pending', 'approved') AND valuation > 1 AND valuation < 1000000000) d
           GROUP BY contractor_id),
    agg AS (SELECT contractor_id, count(*)::int AS permits,
                   count(*) FILTER (WHERE status_stage IN ('pending', 'approved'))::int AS active,
                   max(filed_date) AS latest
              FROM cp GROUP BY contractor_id),
    lic AS (SELECT cl.contractor_id, array_agg(DISTINCT cl.licence_state || ' ' || cl.licence_number) AS licences
              FROM contractor_licenses cl WHERE cl.contractor_id IN (SELECT contractor_id FROM agg) GROUP BY cl.contractor_id)
    SELECT c.id, c.display_name, c.normalized_name, c.business_state, c.primary_trade,
           agg.permits, agg.active, v.active_value, agg.latest, lic.licences
      FROM agg JOIN contractors c ON c.id = agg.contractor_id AND c.party_kind = 'business'
      LEFT JOIN v ON v.contractor_id = agg.contractor_id
      LEFT JOIN lic ON lic.contractor_id = agg.contractor_id`, params);
  return rows;
}

/**
 * State licence records and business registrations for contractors, with how
 * each was matched (an official licence number, or a name / phone join: an
 * inference the caller may hide, docs/DATA_TRUST_AUDIT.md).
 */
async function contractorRecords(ids) {
  const wanted = (ids || []).map(Number).filter(Number.isSafeInteger);
  if (!wanted.length) return { registry: [], registrations: [] };
  const [registry, registrations] = await Promise.all([
    query(`SELECT m.contractor_id, m.provider, m.match_rule, l.licence_number, l.licence_type, l.primary_status, l.expires_on, l.file_date
             FROM contractor_registry_licences m JOIN registry_licences l ON l.id = m.licence_id
            WHERE m.contractor_id = ANY($1::bigint[])`, [wanted]),
    query(`SELECT m.contractor_id, m.provider, m.match_rule, r.legal_name, r.sos_status, r.right_to_transact, r.source_as_of
             FROM contractor_registrations m JOIN business_registrations r ON r.id = m.registration_id
            WHERE m.contractor_id = ANY($1::bigint[])`, [wanted]),
  ]);
  return { registry: registry.rows, registrations: registrations.rows };
}

/**
 * Several permits by id, for a user's saved list. The same columns and the
 * same redaction as getPermit, so a saved permit never shows more than the
 * search does. Order follows `ids`; ids we no longer hold are skipped.
 */
async function permitsByIds(ids) {
  const wanted = [...new Set((ids || []).map(Number).filter(Number.isSafeInteger))];
  if (!wanted.length) return [];
  const [{ rows }, suppressed] = await Promise.all([
    query(`SELECT ${RESULT_COLUMNS}, ${VALUE_REPEATS()}, ${LOCATION_COLUMN()} FROM permits WHERE id = ANY($1::bigint[])`, [wanted]),
    suppressedPhones(),
  ]);
  const byId = new Map(rows.map((r) => [Number(r.id), maskRow(dropSuppressedPhone(redactContractor(r), suppressed))]));
  return wanted.map((id) => byId.get(id)).filter(Boolean);
}

/** Phones under a removal request (009_suppressions.sql), as a Set of E.164. */
async function suppressedPhones() {
  const { rows } = await query('SELECT value FROM suppressed_phones');
  return new Set(rows.map((r) => r.value));
}

/**
 * Freshness: each enabled permit source's latest ingest attempt, with what the
 * source itself says about its delay (src/sources.js `display.publicationLag`)
 * and its credit line. A source the sync no longer runs (the prototype's
 * Oregon scrapers) is left out rather than shown as permanently stale.
 */
async function getFreshness() {
  const { rows } = await query(`
    SELECT DISTINCT ON (r.source_area)
           r.source_area, r.started_at, r.finished_at, r.permits_seen, r.permits_new, r.error,
           s.attribution_text
      FROM ingest_runs r
      LEFT JOIN sources s ON s.slug = r.source_area
     WHERE s.slug IS NULL OR s.enabled
     ORDER BY r.source_area, r.started_at DESC`);
  return rows.map(({ attribution_text: credit, ...r }) => {
    const cfg = SOURCE_CONFIG[r.source_area];
    const display = (cfg && cfg.display) || {};
    return { ...r, label: (cfg && cfg.label) || r.source_area, publicationLag: display.publicationLag || null, attribution: credit || null };
  });
}

/** Credit lines of the enabled enrichment sources (appraisers, licence boards, geocoder). */
async function enrichmentCredits() {
  const { rows } = await query(`
    SELECT slug, attribution_text FROM sources
     WHERE role = 'enrichment' AND enabled AND attribution_text IS NOT NULL AND attribution_text <> ''
     ORDER BY slug`);
  return rows.map((r) => ({ source: r.slug, attribution: r.attribution_text }));
}

module.exports = {
  RESULT_COLUMNS,
  searchPermits, listAreas, listFilterOptions, getPermit, permitsByIds, projectRows, projectCandidates, PROJECT_ROW_CAP,
  contractorsInFilters, contractorRecords, isZipCovered, getFreshness, enrichmentCredits,
  mapClusters, mapPoints, areaCentroids, searchContractors, getContractorHistory, isRealContractor,
  buildWhere, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE,
};
