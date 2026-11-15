// Queries behind the pilot screens (docs/PILOT_UX.md): GC relationships, the
// lead (job) page, contractor profiles and the weekly digest.
//
// Privacy (CLAUDE.md rule 5, ADR-10): a phone reaches a client only from
// contact_points with display_policy = 'show'. A contractor whose name looks
// like a person (party_kind <> 'business') is returned without name or phone;
// see `publicContractor`. Owner and applicant columns are never selected.
//
// Provenance (rule 6): every contact and permit comes back with the permit
// number and raw record it was taken from, and when that record was fetched.

const { query } = require('./index.js');
const { valueBand } = require('../src/value_bands.js');
const { POINT_ONLY } = require('../src/enrichment/parcels.js');
const { publicAliases } = require('../src/privacy.js');
const { maskDescription } = require('../src/description_names.js');
const { SEGMENTS, segmentOf, pickFiler } = require('../src/filers.js');
const insight = require('./insight_queries.js');
const F = require('../src/forecast.js');

const { SOURCES: CONFIG, PILOT_AREAS } = require('../src/sources.js');
const { locationSql } = require('../src/display_policy.js');

const TRADES = ['electrical', 'mechanical', 'plumbing'];
// Every pilot market the screens can show: the synced permit feeds, not the
// application feeds (those are listed through their market's Early screen).
const SOURCES = PILOT_AREAS.filter((s) => CONFIG[s] && CONFIG[s].display);
// Stages before issue (src/lifecycle.js): what the Early screen lists.
const EARLY_STAGES = ['pre_application', 'submitted', 'in_review', 'corrections', 'approved'];

// How recent a building permit must be to count as "open now" when no permit
// for the trade has been issued on the job yet. Austin's median gap from BP to
// a trade permit is 25-63 days (docs/DATA_SOURCES.md), so 60 days.
const OPEN_WINDOW_DAYS = 60;

// Permit trade (permit_parties.trade) -> the key in permits.trade_scores.
const SCORE_KEY = { electrical: 'electrical', mechanical: 'hvac', plumbing: 'plumbing' };

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function parseZips(v) {
  if (!v) return null;
  const zips = String(v).split(',').map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z));
  return zips.length ? zips : null;
}

/** Validated filter set; anything else a client sends is ignored. */
function parseFilters(q = {}) {
  return {
    source: SOURCES.includes(q.source) ? q.source : 'austin-tx',
    trade: TRADES.includes(q.trade) ? q.trade : 'electrical',
    months: clampInt(q.months, 1, 36, 12),
    zips: parseZips(q.zips),
    me: q.me && /^\d+$/.test(String(q.me)) ? Number(q.me) : null,
  };
}

/** A contractor as a client may see it: no person-like names, no non-'show' phones. */
function publicContractor(c) {
  if (!c) return null;
  const business = c.party_kind === 'business';
  return {
    id: business ? Number(c.id) : null,
    name: business ? c.display_name : null,
    withheld: business ? null : 'Looks like an individual; name and contact withheld (ADR-10)',
    partyKind: c.party_kind,
    phone: business ? c.phone || null : null,
  };
}

// Best displayable phone per contractor, with provenance. The contractor's own
// phones first (corroborated, then the one seen on most permits). Failing
// that, a phone reached through the state licence registry: this business
// matched a DBPR licence by its unique name, and the county contractor that
// pulls permits under that same licence number has a shown phone. That is how
// City of Miami firms (no phone column) get one; it is labelled
// 'via_licence' with the licence number, never passed off as its own (rule 6).
const BEST_PHONE = `
  LEFT JOIN LATERAL (
    SELECT x.phone FROM (
      (SELECT 1 AS pri, jsonb_build_object(
               'value', cp.value, 'verification', cp.verification, 'seenOnPermits', cp.seen_on_permits,
               'sharedWithOtherContractors', cp.shared_with_other_contractors, 'lastSeenOn', cp.last_seen_on,
               'source', cp.source, 'sourceRef', cp.source_ref) AS phone
         FROM contact_points cp
        WHERE cp.contractor_id = c.id AND cp.kind = 'phone' AND cp.display_policy = 'show'
          AND cp.value NOT IN (SELECT value FROM suppressed_phones)
        ORDER BY (cp.verification <> 'unverified') DESC, cp.seen_on_permits DESC, cp.last_seen_on DESC NULLS LAST
        LIMIT 1)
      UNION ALL
      (SELECT 2, jsonb_build_object(
               'value', cp.value, 'verification', 'via_licence', 'seenOnPermits', cp.seen_on_permits,
               'sharedWithOtherContractors', cp.shared_with_other_contractors, 'lastSeenOn', cp.last_seen_on,
               'source', cp.source, 'sourceRef', cp.source_ref,
               'viaLicence', jsonb_build_object('provider', l.provider, 'number', l.licence_number, 'contractorId', o.id))
         FROM contractor_registry_licences mine
         JOIN registry_licences l ON l.id = mine.licence_id
         JOIN contractor_registry_licences theirs ON theirs.licence_id = l.id AND theirs.contractor_id <> mine.contractor_id
                                                 AND theirs.match_rule = 'licence'
         JOIN contractors o ON o.id = theirs.contractor_id AND o.party_kind = 'business'
         JOIN contact_points cp ON cp.contractor_id = o.id AND cp.kind = 'phone' AND cp.display_policy = 'show'
        WHERE mine.contractor_id = c.id AND mine.match_rule = 'name_state' AND c.party_kind = 'business'
          AND cp.value NOT IN (SELECT value FROM suppressed_phones)
        ORDER BY cp.seen_on_permits DESC, cp.last_seen_on DESC NULLS LAST
        LIMIT 1)
    ) x ORDER BY x.pri LIMIT 1) ph ON true`;

// One row per building job in the window that has exactly one GC, and the
// trade permits on it. Shared by the GC list and the market baseline.
const JOBS_CTE = `
  bp AS (
    SELECT pp.contractor_id AS gc_id, pp.job_key, pp.issued_on, p.id AS permit_id, p.status_stage
      FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id
     WHERE pp.is_building AND pp.contractor_id IS NOT NULL AND pp.job_key IS NOT NULL
       AND p.source_area = $1
       AND pp.issued_on >= current_date - make_interval(months => $2)
       AND ($3::text[] IS NULL OR p.zip = ANY($3))
  ),
  jobs AS (
    SELECT job_key, min(gc_id) AS gc_id, min(issued_on) AS bp_on, min(permit_id) AS bp_permit_id,
           bool_or(status_stage IN ('finished','cancelled')) AS closed
      FROM bp GROUP BY job_key HAVING count(DISTINCT gc_id) = 1
  ),
  tp AS (
    SELECT j.gc_id, j.job_key, t.contractor_id AS sub_id, t.issued_on, t.permit_id
      FROM jobs j
      JOIN permit_parties t ON t.job_key = j.job_key AND t.trade = $4
      JOIN permits p2 ON p2.id = t.permit_id AND p2.source_area = $1
  ),
  subs AS (  -- one row per job and sub; GC self-performing is not a hire
    SELECT gc_id, job_key, sub_id, min(issued_on) AS issued_on
      FROM tp WHERE sub_id IS NOT NULL AND sub_id <> gc_id
     GROUP BY gc_id, job_key, sub_id
  )`;

/**
 * GCs in an area with how they hire one trade: jobs, subs used, the top sub's
 * share, jobs still without a trade permit, and whether they recently switched.
 */
async function listGcs(f) {
  const params = [f.source, f.months, f.zips, f.trade, OPEN_WINDOW_DAYS];
  const { rows } = await query(`
    WITH ${JOBS_CTE},
    per_sub AS (SELECT gc_id, sub_id, count(*)::int AS n FROM subs GROUP BY gc_id, sub_id),
    gc AS (
      SELECT j.gc_id, count(*)::int AS jobs, max(j.bp_on) AS last_job_on,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM subs s WHERE s.job_key = j.job_key))::int AS trade_jobs,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM tp WHERE tp.job_key = j.job_key AND tp.sub_id = j.gc_id))::int AS self_jobs,
             count(*) FILTER (WHERE NOT j.closed AND j.bp_on >= current_date - $5::int
                                AND NOT EXISTS (SELECT 1 FROM tp WHERE tp.job_key = j.job_key))::int AS open_now
        FROM jobs j GROUP BY j.gc_id
    ),
    -- The latest hire, and who the GC used before it.
    ordered AS (
      SELECT gc_id, sub_id, issued_on, job_key,
             row_number() OVER (PARTITION BY gc_id ORDER BY issued_on DESC NULLS LAST, job_key DESC) AS rn
        FROM subs
    ),
    latest AS (SELECT gc_id, sub_id, issued_on, job_key FROM ordered WHERE rn = 1),
    before AS (
      SELECT o.gc_id, o.sub_id, count(*)::int AS n, sum(count(*)) OVER (PARTITION BY o.gc_id)::int AS total,
             row_number() OVER (PARTITION BY o.gc_id ORDER BY count(*) DESC, o.sub_id) AS rk
        FROM ordered o WHERE o.rn > 1 GROUP BY o.gc_id, o.sub_id
    )
    SELECT c.id, c.display_name, c.party_kind, c.first_permit_on, ph.phone,
           gc.jobs, gc.trade_jobs, gc.self_jobs, gc.open_now, gc.last_job_on,
           (SELECT count(*)::int FROM per_sub s WHERE s.gc_id = gc.gc_id) AS subs_used,
           (SELECT max(n)::int FROM per_sub s WHERE s.gc_id = gc.gc_id) AS top_sub_jobs,
           l.sub_id AS latest_sub_id, l.issued_on AS latest_on,
           (SELECT permit_number FROM permits WHERE id = (SELECT min(permit_id) FROM tp
              WHERE tp.job_key = l.job_key AND tp.sub_id = l.sub_id)) AS latest_permit,
           b.sub_id AS usual_sub_id, b.n AS usual_jobs, b.total AS before_jobs
      FROM gc JOIN contractors c ON c.id = gc.gc_id
      ${BEST_PHONE}
      LEFT JOIN latest l ON l.gc_id = gc.gc_id
      LEFT JOIN before b ON b.gc_id = gc.gc_id AND b.rk = 1
     ORDER BY gc.jobs DESC, c.id
     LIMIT 500`, params);

  // Names for the subs referenced in "changed" rows, in one query.
  const subIds = [...new Set(rows.flatMap((r) => [r.latest_sub_id, r.usual_sub_id]).filter(Boolean))];
  const subs = await contractorsById(subIds);
  return rows.map((r) => {
    const topShare = r.trade_jobs ? r.top_sub_jobs / r.trade_jobs : null;
    const changed = r.usual_sub_id && r.latest_sub_id && r.usual_sub_id !== r.latest_sub_id
      && r.usual_jobs >= 3 && r.usual_jobs / r.before_jobs >= 0.75;
    return {
      gc: publicContractor(r),
      firstSeenOn: r.first_permit_on,
      jobs: r.jobs,
      tradeJobs: r.trade_jobs,
      selfPerformedJobs: r.self_jobs,
      subsUsed: r.subs_used,
      topSubShare: topShare,
      openNow: r.open_now,
      lastJobOn: r.last_job_on,
      segments: {
        spread: r.trade_jobs >= 3 && r.subs_used >= 2 && topShare < 0.6,
        small: r.jobs <= 3,
        changed: Boolean(changed),
      },
      change: changed ? {
        usual: publicContractor(subs.get(String(r.usual_sub_id))), usualJobs: r.usual_jobs, beforeJobs: r.before_jobs,
        latest: publicContractor(subs.get(String(r.latest_sub_id))), latestOn: r.latest_on, latestPermit: r.latest_permit,
      } : null,
    };
  });
}

async function contractorsById(ids) {
  if (!ids.length) return new Map();
  const { rows } = await query(`SELECT c.id, c.display_name, c.party_kind, ph.phone FROM contractors c ${BEST_PHONE}
                                 WHERE c.id = ANY($1::bigint[])`, [ids]);
  return new Map(rows.map((r) => [String(r.id), r]));
}

/**
 * The market baseline the pitch rests on: of trade hires by a GC that already
 * had an earlier hire in that trade, how many went to a sub it had used.
 * Plus the top subs in the trade and, for `me`, each competitor's top GC.
 */
async function marketBaseline(f, { topSubs = true } = {}) {
  const params = [f.source, f.months, f.zips, f.trade];
  const { rows: [b] } = await query(`
    WITH ${JOBS_CTE},
    seq AS (
      SELECT gc_id, sub_id,
             count(*) OVER (PARTITION BY gc_id ORDER BY issued_on, job_key ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior_gc,
             count(*) OVER (PARTITION BY gc_id, sub_id ORDER BY issued_on, job_key ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior_same
        FROM subs
    )
    SELECT (SELECT count(*)::int FROM jobs) AS jobs,
           (SELECT count(DISTINCT job_key)::int FROM subs) AS linked_jobs,
           (SELECT min(bp_on) FROM jobs) AS first_job_on,
           count(*) FILTER (WHERE prior_gc > 0)::int AS eligible_hires,
           count(*) FILTER (WHERE prior_gc > 0 AND prior_same > 0)::int AS repeat_hires
      FROM seq`, params);

  // The overview only needs the rate; skipping the ranking halves its cost.
  const { rows: top } = !topSubs ? { rows: [] } : await query(`
    WITH ${JOBS_CTE},
    per AS (SELECT sub_id, gc_id, count(*)::int AS n FROM subs GROUP BY sub_id, gc_id),
    tot AS (SELECT sub_id, sum(n)::int AS jobs, count(*)::int AS gcs FROM per GROUP BY sub_id),
    best AS (SELECT DISTINCT ON (sub_id) sub_id, gc_id, n FROM per ORDER BY sub_id, n DESC, gc_id)
    SELECT t.sub_id, t.jobs, t.gcs, b.gc_id AS top_gc_id, b.n AS top_gc_jobs
      FROM tot t JOIN best b USING (sub_id)
     ORDER BY t.jobs DESC, t.sub_id LIMIT 25`, params);
  const named = await contractorsById([...new Set(top.flatMap((r) => [r.sub_id, r.top_gc_id]))]);
  return {
    jobs: b.jobs,
    linkedJobs: b.linked_jobs,
    firstJobOn: b.first_job_on,
    eligibleHires: b.eligible_hires,
    repeatHires: b.repeat_hires,
    repeatRate: b.eligible_hires ? b.repeat_hires / b.eligible_hires : null,
    topSubs: top.map((r) => ({
      sub: publicContractor(named.get(String(r.sub_id))), jobs: r.jobs, gcs: r.gcs,
      topGc: publicContractor(named.get(String(r.top_gc_id))), topGcJobs: r.top_gc_jobs,
      isMe: f.me != null && Number(r.sub_id) === f.me,
    })),
  };
}

const display = (slug) => (CONFIG[slug] && CONFIG[slug].display) || {};

/** Freshness for a source: last good sync, last resolver run, history start. */
async function sourceMeta(source) {
  const { rows: [m] } = await query(`
    SELECT s.slug, s.endpoint_url, s.attribution_text, s.redistribution,
           (SELECT max(finished_at) FROM sync_runs r WHERE r.source_id = s.id AND r.status = 'succeeded') AS last_sync_at,
           (SELECT status FROM sync_runs r WHERE r.source_id = s.id ORDER BY started_at DESC LIMIT 1) AS last_sync_status,
           (SELECT max(finished_at) FROM resolver_runs WHERE status = 'succeeded') AS last_resolve_at,
           -- The status-date window also brings in old permits whose status just
           -- changed (one Austin permit dates from 1985), so the earliest date
           -- misstates coverage. The 1st percentile is where history really starts.
           (SELECT percentile_disc(0.01) WITHIN GROUP (ORDER BY pp.issued_on) FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id
             WHERE p.source_area = s.slug AND pp.issued_on IS NOT NULL) AS history_from,
           (SELECT max(pp.issued_on) FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id WHERE p.source_area = s.slug) AS history_to
      FROM sources s WHERE s.slug = $1`, [source]);
  if (!m) return null;
  return {
    source: m.slug, endpoint: m.endpoint_url, attribution: m.attribution_text, redistribution: m.redistribution,
    lastSyncAt: m.last_sync_at, lastSyncStatus: m.last_sync_status, lastResolveAt: m.last_resolve_at,
    historyFrom: m.history_from, historyTo: m.history_to,
    // Measured 2026-11-13 (docs/DATA_SOURCES.md). Not a live number.
    publicationLag: (display(m.slug).publicationLag) || null,
    city: display(m.slug).city || null,
    jobLink: display(m.slug).jobLink || null,
    earlySources: display(m.slug).early || [],
    earlyLag: display(m.slug).earlyLag || null,
    label: (CONFIG[m.slug] && CONFIG[m.slug].label) || m.slug,
  };
}

// Permit columns a client may see (no owner/applicant: src/privacy.js).
const PERMIT_COLS = `p.id, p.source_area, p.permit_number, p.address, p.city, p.state, p.zip, p.permit_type,
  p.work_description, p.valuation, p.status_raw, p.status_stage, p.lifecycle_stage, p.filing_kind, p.permit_url, p.filed_date, p.trade_scores,
  p.first_seen_at, p.last_seen_at`;

async function provenanceFor(rawRecordId) {
  if (!rawRecordId) return null;
  const { rows: [r] } = await query(`
    SELECT r.id, r.fetched_at, r.sync_run_id, s.slug, s.endpoint_url
      FROM raw_records r JOIN sources s ON s.id = r.source_id WHERE r.id = $1`, [rawRecordId]);
  return r ? { rawRecordId: Number(r.id), fetchedAt: r.fetched_at, syncRunId: Number(r.sync_run_id), source: r.slug, endpoint: r.endpoint_url } : null;
}

/**
 * State licence registry records linked to contractors (ADR-15 item 1), with
 * how each was matched and the credit and date of the file it came from.
 * Codes are as published; the holder name is never returned (rule 5).
 * Only for businesses: callers pass business contractor ids.
 * @returns {Map<string, object[]>} by contractor id
 */
async function registryFor(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const { rows } = await query(`
    SELECT cl.contractor_id, cl.match_rule, cl.match_confidence, l.provider, l.licence_number, l.licence_type, l.class_code,
           l.primary_status, l.secondary_status, l.expires_on, l.phone, l.file_date, l.fetched_at, s.attribution_text
      FROM contractor_registry_licences cl JOIN registry_licences l ON l.id = cl.licence_id
      JOIN sources s ON s.slug = l.provider
     WHERE cl.contractor_id = ANY($1::bigint[])
     ORDER BY cl.match_confidence DESC, l.licence_number`, [ids]);
  for (const r of rows) {
    const k = String(r.contractor_id);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({
      provider: r.provider, number: r.licence_number, type: r.licence_type, classCode: r.class_code,
      // DBPR codes are not decoded here: their meaning is DBPR's to state.
      status: r.primary_status || r.secondary_status ? { primary: r.primary_status, secondary: r.secondary_status } : null,
      expiresOn: r.expires_on, expired: r.expires_on ? new Date(r.expires_on) < new Date(new Date().toISOString().slice(0, 10)) : null,
      businessPhone: r.phone,
      matchedBy: r.match_rule, confidence: Number(r.match_confidence),
      provenance: { source: r.provider, attribution: r.attribution_text, fileDate: r.file_date, fetchedAt: r.fetched_at },
    });
  }
  return out;
}

/**
 * State business registrations (franchise-tax file) matched to contractors:
 * the business facts only, with how and when each was matched (rule 6).
 * Officers and registered agents are never stored, so never shown (rule 5).
 */
async function registrationsFor(ids) {
  const out = new Map();
  if (!ids.length) return out;
  // An optional panel: the app can deploy before the sync applies its
  // migration (024), and a missing table must not take the page down. Any
  // other error still throws.
  let rows;
  try {
    ({ rows } = await query(`
    SELECT cr.contractor_id, cr.match_rule, cr.match_confidence, b.provider, b.registry_id, b.legal_name, b.dba_name,
           b.sos_file_number, b.state_of_formation, b.sos_status, b.right_to_transact, b.sos_registered_on, b.report_year,
           b.mailing_city, b.mailing_state, b.fetched_at, s.attribution_text
      FROM contractor_registrations cr JOIN business_registrations b ON b.id = cr.registration_id
      JOIN sources s ON s.slug = b.provider
     WHERE cr.contractor_id = ANY($1::bigint[])
     ORDER BY cr.match_confidence DESC, b.registry_id`, [ids]));
  } catch (err) {
    if (err.code === '42P01') { console.warn('registrations panel skipped: migration 024 not applied yet'); return out; }
    throw err;
  }
  for (const r of rows) {
    const k = String(r.contractor_id);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({
      provider: r.provider, taxpayerId: r.registry_id, legalName: r.legal_name, dbaName: r.dba_name,
      sosFileNumber: r.sos_file_number, stateOfFormation: r.state_of_formation, sosStatus: r.sos_status,
      rightToTransact: r.right_to_transact, registeredOn: r.sos_registered_on, reportYear: r.report_year,
      mailingCity: r.mailing_city, mailingState: r.mailing_state,
      matchedBy: r.match_rule, confidence: Number(r.match_confidence),
      provenance: { source: r.provider, attribution: r.attribution_text, fetchedAt: r.fetched_at },
    });
  }
  return out;
}

/**
 * Facts about the parcel the permit is on, from an official appraiser, with
 * where and when each came from (rule 6). Null when the permit's source has no
 * parcel id or the appraiser has no such parcel. Owner fields are never stored.
 */
async function propertyFor(permitId) {
  const { rows: [r] } = await query(`
    SELECT c.parcel_key, c.land_use_code, c.land_use, c.year_built, c.heated_sqft, c.building_sqft, c.lot_sqft, c.bedrooms,
           c.bathrooms, c.units, c.floors, c.assessed_value, c.assessment_year, c.site_zip, c.fetched_at, c.source_edited_at,
           c.land_value, c.improvement_value, c.improvement_type,
           pc.match_rule, s.slug, s.endpoint_url, s.attribution_text
      FROM permit_parcels pc JOIN parcels c ON c.id = pc.parcel_id
      JOIN sources s ON s.slug = pc.provider
     WHERE pc.permit_id = $1 AND c.found AND pc.provider <> ALL($2::text[])
     ORDER BY pc.provider LIMIT 1`, [permitId, POINT_ONLY]);
  if (!r) return null;
  const num = (v) => (v == null ? null : Number(v));
  return {
    parcelId: r.parcel_key, landUseCode: r.land_use_code, landUse: r.land_use, yearBuilt: r.year_built,
    heatedSqft: num(r.heated_sqft), buildingSqft: num(r.building_sqft), lotSqft: num(r.lot_sqft), bedrooms: num(r.bedrooms),
    bathrooms: num(r.bathrooms), units: num(r.units), floors: num(r.floors),
    // Values leave the server as bands only, never exact (ADR-23 decision 3).
    assessedValueBand: valueBand(r.assessed_value), assessmentYear: r.assessment_year, siteZip: r.site_zip,
    landValueBand: valueBand(r.land_value), improvementValueBand: valueBand(r.improvement_value), improvementType: r.improvement_type,
    // Appraisal values are estimates for one roll year; Travis CAD asks that both be said.
    valueNote: r.land_value != null || r.improvement_value != null || r.assessed_value != null
      ? `Appraisal estimate${r.assessment_year ? `, ${r.assessment_year} roll` : ''}, shown as a range` : null,
    provenance: { source: r.slug, endpoint: r.endpoint_url, attribution: r.attribution_text, matchedBy: r.match_rule,
      fetchedAt: r.fetched_at, sourceEditedAt: r.source_edited_at },
  };
}

/**
 * Where the permit's job site is, and how we know (rule 6): the source's own
 * coordinates, the appraiser parcel, or the Census geocoder (with its match
 * quality and required notice). Null when no method placed it.
 */
async function locationFor(permitId) {
  const { rows: [r] } = await query(`
    SELECT l.lat, l.lng, l.method, l.quality, l.located_at, g.matched_address, g.benchmark,
           s.slug, s.attribution_text
      FROM permit_locations l
      JOIN permits p ON p.id = l.permit_id
      LEFT JOIN geocode_cache g ON g.address_key = l.address_key
      LEFT JOIN permit_parcels pp ON pp.permit_id = l.permit_id AND pp.parcel_id = l.parcel_id
      JOIN sources s ON s.slug = CASE l.method WHEN 'source' THEN p.source_area WHEN 'parcel' THEN pp.provider ELSE 'us-census-geocoder' END
     WHERE l.permit_id = $1 AND ${locationSql('l')}`, [permitId]);
  if (!r) return null;
  return {
    lat: r.lat, lng: r.lng, method: r.method, quality: r.quality,
    // A Census point is placed along the street's address range; one it could
    // not match exactly is shown as approximate.
    approximate: r.method === 'census' && r.quality !== 'exact',
    provenance: { source: r.slug, attribution: r.attribution_text, locatedAt: r.located_at,
      ...(r.method === 'census' ? { matchedAddress: r.matched_address, benchmark: r.benchmark } : {}) },
  };
}

/**
 * The lead page: one building permit, the other permits on its job, the GC with
 * its displayable phone, and how that GC has hired this trade.
 */
async function getJob(permitId, f) {
  const { rows: [bp] } = await query(`
    SELECT ${PERMIT_COLS}, pp.job_key, pp.is_building, pp.contractor_id, pp.raw_record_id, pp.match_rule, pp.match_confidence,
           pp.issued_on AS bp_issued_on
      FROM permits p LEFT JOIN permit_parties pp ON pp.permit_id = p.id AND pp.role = 'contractor'
     WHERE p.id = $1`, [permitId]);
  if (!bp) return null;
  const bpIssuedOn = bp.bp_issued_on;
  delete bp.bp_issued_on;

  const { rows: related } = bp.job_key ? await query(`
    SELECT ${PERMIT_COLS}, pp.trade, pp.is_building, pp.issued_on, pp.contractor_id, pp.raw_record_id
      FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id
     WHERE pp.job_key = $1 AND p.source_area = $2 AND p.id <> $3
     ORDER BY pp.issued_on NULLS LAST, p.permit_number`, [bp.job_key, bp.source_area, bp.id]) : { rows: [] };

  const people = await contractorsById([...new Set([bp.contractor_id, ...related.map((r) => r.contractor_id)].filter(Boolean))]);
  const gc = people.get(String(bp.contractor_id));

  let hiring = null;
  if (gc && gc.party_kind === 'business') {
    const { rows } = await query(`
      WITH jobs AS (
        SELECT DISTINCT pp.job_key FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id
         WHERE pp.is_building AND pp.contractor_id = $1 AND p.source_area = $2 AND pp.job_key IS NOT NULL
      )
      SELECT t.contractor_id AS sub_id, count(DISTINCT t.job_key)::int AS jobs
        FROM jobs j JOIN permit_parties t ON t.job_key = j.job_key AND t.trade = $3
        JOIN permits p ON p.id = t.permit_id AND p.source_area = $2
       WHERE t.contractor_id IS NOT NULL AND t.contractor_id <> $1
       GROUP BY t.contractor_id ORDER BY jobs DESC, t.contractor_id LIMIT 10`, [bp.contractor_id, bp.source_area, f.trade]);
    const { rows: [counts] } = await query(`
      SELECT count(DISTINCT pp.job_key)::int AS jobs, max(pp.issued_on) AS last_on
        FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id
       WHERE pp.is_building AND pp.contractor_id = $1 AND p.source_area = $2`, [bp.contractor_id, bp.source_area]);
    const named = await contractorsById(rows.map((r) => r.sub_id));
    const total = rows.reduce((n, r) => n + r.jobs, 0);
    hiring = {
      buildingJobs: counts.jobs, lastJobOn: counts.last_on,
      subs: rows.map((r) => ({ sub: publicContractor(named.get(String(r.sub_id))), jobs: r.jobs })),
      subsUsed: rows.length, topSubShare: total ? rows[0].jobs / total : null,
    };
  }

  const tradeFiled = related.filter((r) => r.trade === f.trade);
  // Estimates for the trades with no permit yet (ADR-21): building permits only.
  const missing = TRADES.filter((t) => !related.some((r) => r.trade === t));
  const outlook = bp.is_building && bp.job_key && missing.length && !['finished', 'cancelled'].includes(bp.status_stage)
    ? await insight.tradeOutlook({ source: bp.source_area, gcId: bp.contractor_id, cls: await insight.permitClass(bp.source_area, bp.id), bpIssuedOn, trades: missing })
    : {};
  return {
    tradeOutlook: outlook,
    property: await propertyFor(bp.id),
    location: await locationFor(bp.id),
    lifecycle: await lifecycleFor(bp.id),
    trade: f.trade,
    permit: stripInternal(bp),
    isBuilding: Boolean(bp.is_building),
    match: bp.match_rule ? { rule: bp.match_rule, confidence: bp.match_confidence == null ? null : Number(bp.match_confidence) } : null,
    provenance: await provenanceFor(bp.raw_record_id),
    gc: publicContractor(gc),
    gcRegistry: gc && gc.party_kind === 'business' ? ((await registryFor([gc.id])).get(String(gc.id)) || []) : [],
    gcRegistrations: gc && gc.party_kind === 'business' ? ((await registrationsFor([gc.id])).get(String(gc.id)) || []) : [],
    gcHiring: hiring,
    tradePermitIssued: tradeFiled.length > 0,
    related: related.map((r) => ({
      ...stripInternal(r), trade: r.trade, isBuilding: r.is_building, issuedOn: r.issued_on,
      contractor: publicContractor(people.get(String(r.contractor_id))),
    })),
    meta: await sourceMeta(bp.source_area),
  };
}

/**
 * A filing's lifecycle (ADR-16): the stage, the source's official dates kept
 * apart from when we first saw it, its status history, and the application
 * that led to it (an Austin plan-review case), each with its own dates.
 * History rows from before migration 017 have no stage: shown as missing.
 */
async function lifecycleFor(permitId) {
  const one = async (id) => {
    const { rows: [p] } = await query(`
      SELECT p.id, p.source_area, p.permit_number, p.filing_kind, p.lifecycle_stage, p.first_seen_stage, p.submitted_on, p.stage_since,
             p.first_seen_at, p.status_raw, p.permit_url FROM permits p WHERE p.id = $1`, [id]);
    if (!p) return null;
    const { rows: history } = await query(`
      SELECT status_raw, lifecycle_stage, stage_since, observed_at FROM permit_status_history WHERE permit_id = $1 ORDER BY observed_at, id`, [id]);
    return {
      source: p.source_area, permitNumber: p.permit_number, filingKind: p.filing_kind, stage: p.lifecycle_stage, status: p.status_raw,
      firstSeenStage: p.first_seen_stage, submittedOn: p.submitted_on, stageSince: p.stage_since, firstSeenAt: p.first_seen_at, url: p.permit_url,
      history: history.map((h) => ({ status: h.status_raw, stage: h.lifecycle_stage, stageSince: h.stage_since, observedAt: h.observed_at })),
    };
  };
  const self = await one(permitId);
  if (!self) return null;
  const { rows: links } = await query(`
    SELECT from_permit_id, link_basis, basis_detail, confidence FROM permit_links WHERE to_permit_id = $1 ORDER BY from_permit_id`, [permitId]);
  const applications = [];
  for (const l of links) {
    applications.push({ ...(await one(l.from_permit_id)), link: { basis: l.link_basis, detail: l.basis_detail, confidence: Number(l.confidence) } });
  }
  return { ...self, applications };
}

function stripInternal(r) {
  const { job_key: _j, contractor_id: _c, raw_record_id: _r, match_rule: _m, match_confidence: _mc,
    trade: _t, is_building: _b, issued_on: _i, ...rest } = r;
  return { ...rest, id: Number(rest.id), valuation: rest.valuation == null ? null : Number(rest.valuation),
    // Names inside a description are masked for display (rule 5).
    work_description: maskDescription(rest.work_description) };
}

/** A contractor's profile. Individuals return a withheld stub, never their details. */
async function getContractor(id) {
  const { rows: [c] } = await query(`
    SELECT c.*, ph.phone FROM contractors c ${BEST_PHONE} WHERE c.id = $1`, [id]);
  if (!c) return null;
  const pub = publicContractor(c);
  if (c.party_kind !== 'business') return { contractor: pub };

  const [phones, aliases, licences, asGc, asSub, recent] = await Promise.all([
    query(`SELECT value, verification, seen_on_permits, shared_with_other_contractors, last_seen_on, source, source_ref
             FROM contact_points WHERE contractor_id = $1 AND kind = 'phone' AND display_policy = 'show'
              AND value NOT IN (SELECT value FROM suppressed_phones)
            ORDER BY seen_on_permits DESC`, [id]),
    query('SELECT raw_name, seen_count FROM contractor_aliases WHERE contractor_id = $1 ORDER BY seen_count DESC LIMIT 20', [id]),
    query('SELECT licence_state, licence_number, source FROM contractor_licenses WHERE contractor_id = $1', [id]),
    query(`SELECT r.sub_id AS other_id, r.trade, r.jobs, r.first_job_on, r.last_job_on FROM contractor_relationships r
            WHERE r.gc_id = $1 ORDER BY r.jobs DESC LIMIT 30`, [id]),
    query(`SELECT r.gc_id AS other_id, r.trade, r.jobs, r.first_job_on, r.last_job_on FROM contractor_relationships r
            WHERE r.sub_id = $1 ORDER BY r.jobs DESC LIMIT 30`, [id]),
    query(`SELECT ${PERMIT_COLS}, pp.trade, pp.is_building, pp.issued_on FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id
            WHERE pp.contractor_id = $1 ORDER BY pp.issued_on DESC NULLS LAST LIMIT 25`, [id]),
  ]);
  const named = await contractorsById([...new Set([...asGc.rows, ...asSub.rows].map((r) => r.other_id))]);
  const rel = (r) => ({ other: publicContractor(named.get(String(r.other_id))), trade: r.trade, jobs: r.jobs, firstJobOn: r.first_job_on, lastJobOn: r.last_job_on });
  return {
    contractor: { ...pub, primaryTrade: c.primary_trade, businessCity: c.business_city, businessState: c.business_state,
      firstPermitOn: c.first_permit_on, lastPermitOn: c.last_permit_on, permitCount: c.permit_count, resolverVersion: c.resolver_version },
    phones: phones.rows.map((p) => ({ value: p.value, verification: p.verification, seenOnPermits: p.seen_on_permits,
      sharedWithOtherContractors: p.shared_with_other_contractors, lastSeenOn: p.last_seen_on, source: p.source, sourceRef: p.source_ref })),
    aliases: publicAliases(aliases.rows.map((a) => ({ name: a.raw_name, seen: a.seen_count }))),
    licences: licences.rows.map((l) => ({ state: l.licence_state, number: l.licence_number, source: l.source })),
    registry: (await registryFor([id])).get(String(id)) || [],
    registrations: (await registrationsFor([id])).get(String(id)) || [],
    subsHired: asGc.rows.map(rel),
    gcsWorkedFor: asSub.rows.map(rel),
    recentPermits: recent.rows.map((r) => ({ ...stripInternal(r), trade: r.trade, isBuilding: r.is_building, issuedOn: r.issued_on })),
  };
}

/**
 * Digest leads: building permits we first saw in the last `days` days, in the
 * area, with no permit for the trade issued on the job yet, ranked by the
 * permit's precomputed trade score. "Not issued" is all the data can say:
 * the source lists issued permits only, so one may be in review.
 * `since` (a timestamp) narrows to permits first seen after it, and
 * `issuedWithinDays` drops old permits a backfill has just brought in (both
 * for the email digest, src/digest).
 */
async function listLeads(f, { days = 7, limit = 25, minValuation = null, since = null, issuedWithinDays = null, order = 'score' } = {}) {
  const { rows } = await query(`
    SELECT ${PERMIT_COLS}, pp.contractor_id, pp.issued_on, (p.trade_scores ->> $7)::numeric AS score
      FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id
     WHERE pp.is_building AND p.source_area = $1
       AND p.first_seen_at >= now() - make_interval(days => $2)
       AND ($8::timestamptz IS NULL OR p.first_seen_at >= $8)
       AND ($9::int IS NULL OR pp.issued_on >= current_date - $9::int)
       AND ($3::text[] IS NULL OR p.zip = ANY($3))
       AND coalesce(p.status_stage, 'unknown') NOT IN ('finished','cancelled')
       AND ($6::numeric IS NULL OR p.valuation >= $6)
       AND NOT EXISTS (SELECT 1 FROM permit_parties t JOIN permits p2 ON p2.id = t.permit_id
                        WHERE t.job_key = pp.job_key AND t.trade = $4 AND p2.source_area = $1)
     ORDER BY ${order === 'date' ? 'pp.issued_on DESC NULLS LAST, p.id DESC' : 'score DESC NULLS LAST, p.valuation DESC NULLS LAST, p.id'}
     LIMIT $5`, [f.source, days, f.zips, f.trade, limit, minValuation, SCORE_KEY[f.trade], since, issuedWithinDays]);
  const people = await contractorsById([...new Set(rows.map((r) => r.contractor_id).filter(Boolean))]);
  return rows.map((r) => ({
    ...stripInternal(r), score: r.score == null ? null : Number(r.score), issuedOn: r.issued_on,
    gc: publicContractor(people.get(String(r.contractor_id))),
  }));
}

/**
 * The Early screen (ADR-16): filings in a market that are not issued yet,
 * newest submission first. Austin's come from the plan-review feed, Raleigh's
 * from its own layers; markets that publish issued permits only have none.
 * Dates are the source's own (submitted_on, stage_since) beside when we first
 * saw the filing. A contractor is shown only where the filing names one, under
 * the same rule as every screen; applicants and owners are never selected.
 */
async function listEarly(f, { days = 30, limit = 100, segment = null, since = null } = {}) {
  const areas = display(f.source).early || [];
  if (!areas.length) return { available: false, filings: [], counts: [] };
  // The segments read Austin's plan-review sub types ("R- 101 ..."); other
  // feeds word their types differently, so they are not segmented.
  const segmentable = areas.includes('austin-plan-review-tx');
  const pattern = segmentable && segment && SEGMENTS[segment] ? SEGMENTS[segment].pattern : null;
  // `since` (the email digest): only filings first seen after that moment.
  const base = `p.source_area = ANY($1::text[]) AND p.lifecycle_stage = ANY($2::text[])
       AND coalesce(p.submitted_on, p.first_seen_at::date) >= current_date - $3::int
       AND ($4::text[] IS NULL OR p.zip = ANY($4))
       AND ($5::timestamptz IS NULL OR p.first_seen_at >= $5)`;
  const where = `${base} AND ($6::text IS NULL OR p.permit_type ~* $6)`;
  const args = [areas, EARLY_STAGES, days, f.zips, since, pattern, limit];
  const segmentCols = Object.keys(SEGMENTS).map((k, i) => `count(*) FILTER (WHERE p.permit_type ~* $${6 + i})::int AS ${k}`).join(', ');
  const [{ rows }, { rows: counts }, { rows: [segmentCounts] }] = await Promise.all([
    query(`
      SELECT ${PERMIT_COLS}, p.first_seen_stage, p.submitted_on, p.stage_since,
             pp.contractor_id, pp.is_building, pp.trade,
             (SELECT k.to_permit_id FROM permit_links k WHERE k.from_permit_id = p.id ORDER BY k.to_permit_id LIMIT 1) AS permit_id,
             (SELECT coalesce(json_agg(json_build_object('key', o.org_key, 'name', o.display_name, 'partyKind', o.party_kind,
                       'role', o.role, 'basis', o.basis, 'filings', o.filings, 'contractorId', o.contractor_id,
                       'rawRecordId', ff.raw_record_id) ORDER BY o.org_key), '[]'::json)
                FROM filing_filers ff JOIN filer_orgs o ON o.org_key = ff.org_key WHERE ff.permit_id = p.id) AS filers
        FROM permits p LEFT JOIN permit_parties pp ON pp.permit_id = p.id AND pp.role = 'contractor'
       WHERE ${where}
       ORDER BY coalesce(p.submitted_on, p.first_seen_at::date) DESC, p.valuation DESC NULLS LAST, p.id
       LIMIT $7`, args),
    query(`SELECT p.lifecycle_stage AS stage, count(*)::int AS n FROM permits p WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, args.slice(0, 6)),
    query(`SELECT ${segmentCols} FROM permits p WHERE ${base}`, [...args.slice(0, 5), ...Object.values(SEGMENTS).map((x) => x.pattern)]),
  ]);
  const shown = new Map(rows.map((r) => [String(r.id), pickFiler(r.filers || [])]));
  const builderIds = [...new Set([...shown.values()].filter((x) => x && x.role === 'builder' && x.contractorId).map((x) => x.contractorId))];
  const [people, subs] = await Promise.all([
    contractorsById([...new Set(rows.map((r) => r.contractor_id).filter(Boolean))]),
    builderSubs(builderIds),
  ]);
  // When each filing is likely to be issued (ADR-21): an estimate from permits
  // issued in this market, never a date the city has given.
  const forecasts = new Map();
  for (const r of rows) {
    forecasts.set(String(r.id), await insight.forecastFiling(f.source, {
      submittedOn: r.submitted_on,
      kind: r.is_building === false ? (r.trade || 'other') : 'building',
      cls: segmentable ? r.permit_type : null,
      segment: segmentable ? segmentOf(r.permit_type) : null,
    }));
  }
  return {
    available: true,
    segmentable,
    segment: pattern ? segment : null,
    counts,
    segmentCounts: segmentable ? segmentCounts || null : null,
    filings: rows.map((r) => {
      const { lifecycle_stage: stage, first_seen_stage: firstSeenStage, submitted_on: submittedOn, stage_since: stageSince,
        filing_kind: filingKind, permit_id: permitId, filers, ...rest } = r;
      const filer = publicFiler(shown.get(String(r.id)));
      return {
        ...stripInternal(rest), stage, firstSeenStage, submittedOn, stageSince, filingKind,
        segment: segmentOf(r.permit_type),
        trade: r.trade || null, isBuilding: r.is_building == null ? null : Boolean(r.is_building),
        issuedPermitId: permitId == null ? null : Number(permitId),
        contractor: publicContractor(people.get(String(r.contractor_id))),
        filer,
        filerWithheld: !filer && (filers || []).length > 0,
        builderSubs: filer && filer.role === 'builder' && filer.contractorId ? subs.get(String(filer.contractorId)) || [] : [],
        issueForecast: forecasts.get(String(r.id)) || null,
      };
    }),
  };
}

/**
 * The business that filed, for a client (rule 5): business-kind only, never
 * the owner (src/filers.js filersOf drops it), with the evidence for its role
 * and the raw record it came from (rule 6).
 */
function publicFiler(o) {
  if (!o || o.partyKind !== 'business') return null;
  return {
    name: o.name, role: o.role, basis: o.basis, filings: o.filings,
    contractorId: o.contractorId == null ? null : Number(o.contractorId),
    rawRecordId: o.rawRecordId == null ? null : Number(o.rawRecordId),
  };
}

/** The business shown as having filed one application (same rule as the Early screen), or null. */
async function filersFor(permitId) {
  const { rows } = await query(`
    SELECT o.org_key AS key, o.display_name AS name, o.party_kind AS "partyKind", o.role, o.basis, o.filings,
           o.contractor_id AS "contractorId", ff.raw_record_id AS "rawRecordId"
      FROM filing_filers ff JOIN filer_orgs o ON o.org_key = ff.org_key WHERE ff.permit_id = $1 ORDER BY o.org_key`, [permitId]);
  const filer = publicFiler(pickFiler(rows));
  return { filer, withheld: !filer && rows.length > 0 };
}

/**
 * Each builder's past subs, top three per trade, from issued permits
 * (contractor_relationships, ADR-12). History, not a claim about this job.
 */
async function builderSubs(gcIds, perTrade = 3) {
  if (!gcIds.length) return new Map();
  const { rows } = await query(`
    SELECT * FROM (
      SELECT r.gc_id, r.sub_id, r.trade, r.jobs, r.last_job_on,
             sum(r.jobs) OVER (PARTITION BY r.gc_id, r.trade)::int AS trade_jobs,
             row_number() OVER (PARTITION BY r.gc_id, r.trade ORDER BY r.jobs DESC, r.last_job_on DESC NULLS LAST, r.sub_id) AS n
        FROM contractor_relationships r WHERE r.gc_id = ANY($1::bigint[]) AND r.sub_id <> r.gc_id) x
     WHERE n <= $2 ORDER BY gc_id, trade, n`, [gcIds, perTrade]);
  const named = await contractorsById([...new Set(rows.map((r) => r.sub_id))]);
  const out = new Map();
  for (const r of rows) {
    const list = out.get(String(r.gc_id)) || [];
    list.push({ trade: r.trade, sub: publicContractor(named.get(String(r.sub_id))), jobs: r.jobs, tradeJobs: r.trade_jobs, lastJobOn: r.last_job_on });
    out.set(String(r.gc_id), list);
  }
  return out;
}

/**
 * Builder momentum (ADR-21): each business's building jobs in the last
 * `windowDays` against the same span before it, from issued permits we hold,
 * plus (where the market has an application feed) the applications it filed
 * in the recent window, and how many are still in review. Counts are facts
 * from the records; the trend label is our reading of them, defined in
 * src/forecast.js momentum(). Individuals are left out (rule 5).
 */
async function listMomentum(f, { windowDays = F.MOMENTUM_WINDOW_DAYS, segment = null, limit = 150, sort = 'trend' } = {}) {
  const meta = await sourceMeta(f.source);
  const classField = insight.CLASS_FIELD[f.source];
  const pattern = classField && segment && SEGMENTS[segment] ? SEGMENTS[segment].pattern : null;
  const { rows } = await query(`
    WITH bp AS (
      SELECT pp.contractor_id AS gc_id, pp.job_key, min(pp.issued_on) AS issued_on
        FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id
       WHERE pp.is_building AND pp.contractor_id IS NOT NULL AND pp.job_key IS NOT NULL AND p.source_area = $1
         AND pp.issued_on > current_date - 2 * $2::int AND pp.issued_on <= current_date
         AND ($3::text[] IS NULL OR p.zip = ANY($3))
         AND ($4::text IS NULL OR ${insight.classSql(f.source)} ~* $4)
       GROUP BY 1, 2
    ),
    g AS (
      SELECT gc_id, count(*) FILTER (WHERE issued_on > current_date - $2::int)::int AS recent,
             count(*) FILTER (WHERE issued_on <= current_date - $2::int)::int AS prior, max(issued_on) AS last_on
        FROM bp GROUP BY gc_id
    )
    SELECT c.id, c.display_name, c.party_kind, c.first_permit_on, ph.phone, g.recent, g.prior, g.last_on
      FROM g JOIN contractors c ON c.id = g.gc_id AND c.party_kind = 'business'
      ${BEST_PHONE}
     WHERE g.recent >= $5 OR g.prior >= $5`, [f.source, windowDays, f.zips, pattern, F.MOMENTUM_MIN_RECENT]);

  // History must reach back over the earlier window, or the change is withheld.
  const priorFrom = new Date(Date.now() - 2 * windowDays * 86400000).toISOString().slice(0, 10);
  const historyCovers = Boolean(meta && meta.historyFrom && String(new Date(meta.historyFrom).toISOString()).slice(0, 10) <= priorFrom);
  const recentFrom = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);

  // Applications the builder filed recently (Austin plan review): what is
  // coming before any permit is issued.
  const early = (meta && meta.earlySources) || [];
  const ids = rows.map((r) => r.id);
  const apps = new Map();
  if (early.length && ids.length) {
    const appPattern = early.includes('austin-plan-review-tx') && segment && SEGMENTS[segment] ? SEGMENTS[segment].pattern : null;
    const { rows: a } = await query(`
      SELECT o.contractor_id, count(DISTINCT p.id)::int AS filed,
             count(DISTINCT p.id) FILTER (WHERE p.lifecycle_stage = ANY($4::text[]))::int AS in_review
        FROM filing_filers ff JOIN filer_orgs o ON o.org_key = ff.org_key JOIN permits p ON p.id = ff.permit_id
       WHERE o.role = 'builder' AND o.contractor_id = ANY($1::bigint[]) AND p.source_area = ANY($2::text[])
         AND coalesce(p.submitted_on, p.first_seen_at::date) > current_date - $3::int
         AND ($5::text IS NULL OR p.permit_type ~* $5)
       GROUP BY 1`, [ids, early, windowDays, EARLY_STAGES, appPattern]);
    for (const r of a) apps.set(String(r.contractor_id), { filed: r.filed, inReview: r.in_review });
  }
  const builders = rows.map((r) => {
    const m = F.momentum(r.recent, r.prior, {
      historyCovers,
      firstSeenRecently: Boolean(r.first_permit_on && String(new Date(r.first_permit_on).toISOString()).slice(0, 10) > recentFrom),
    });
    return { builder: publicContractor(r), firstSeenOn: r.first_permit_on, lastJobOn: r.last_on, ...m,
      applications: early.length ? apps.get(String(r.id)) || { filed: 0, inReview: 0 } : null };
  });
  const rank = { rising: 0, new: 1, slowing: 2, steady: 3, unknown: 4 };
  if (sort === 'recent') builders.sort((a, b) => b.recent - a.recent || (b.prior ?? 0) - (a.prior ?? 0) || a.builder.id - b.builder.id);
  else builders.sort((a, b) => rank[a.trend] - rank[b.trend] || (b.change ?? b.recent) - (a.change ?? a.recent)
    || b.recent - a.recent || a.builder.id - b.builder.id);
  const shown = builders.slice(0, limit);
  const subs = await builderSubs(shown.map((b) => b.builder.id), 1);
  for (const b of shown) b.topSubs = subs.get(String(b.builder.id)) || [];
  const counts = builders.reduce((m, b) => ({ ...m, [b.trend]: (m[b.trend] || 0) + 1 }), {});
  return {
    windowDays, segment: pattern ? segment : null, segmentable: Boolean(classField), historyCovers, recentFrom, priorFrom,
    hasApplications: early.length > 0, counts, total: builders.length, builders: shown, meta,
  };
}

module.exports = {
  listMomentum,
  TRADES, SOURCES, OPEN_WINDOW_DAYS, EARLY_STAGES, SCORE_KEY, listEarly, publicFiler, builderSubs, contractorsById, filersFor,
  parseFilters, publicContractor, listGcs, marketBaseline, sourceMeta, getJob, getContractor, listLeads, lifecycleFor,
};
