// What the screens may show (docs/DATA_TRUST_AUDIT.md, owner decision
// 2026-11-14): recorded facts (class A) and deterministic counts on official
// keys (class B). Inferences (class C) are still computed and stored, but are
// removed from API answers unless SHOW_INFERENCES=1. Stripping happens here,
// on the way out, so no query or estimate code changes and turning the flag on
// restores today's answers exactly.
//
// Class C, as stripped:
//   - estimates: issueForecast, tradeOutlook, momentum trend labels
//   - trade fit scores (and ranking the weekly list by them)
//   - builder / expediter role tags, and anything keyed on them
//   - licence matches by name or phone; business registrations (name joins)
//   - Street View photos (camera-distance heuristic)
//   - Raleigh job links: trade permits join building permits by parcel PIN,
//     which is not a job key, so its GC-sub counts and trade-on-job are out

const RALEIGH = 'raleigh-nc';
const PIN_NOTE = 'Raleigh links trade permits to building permits only by parcel (PIN). A parcel holds many jobs over the years, so which subs worked on which job is not certain and is not shown.';

const showInferences = (env = process.env) => env.SHOW_INFERENCES === '1';
const { showUnmeasured } = require('../src/display_policy.js');

const licenceOnly = (recs) => (recs || []).filter((r) => r.matchedBy === 'licence');

function job(d) {
  const out = { ...d, tradeOutlook: {}, gcRegistrations: [], gcRegistry: licenceOnly(d.gcRegistry) };
  if (d.permit) {
    const { trade_scores: _ts, ...permit } = d.permit;
    out.permit = permit;
  }
  if (d.permit && d.permit.source_area === RALEIGH) {
    out.related = [];
    out.gcHiring = null;
    out.tradePermitIssued = null;
    out.jobLinksHidden = PIN_NOTE;
  }
  return out;
}

function contractor(d) {
  if (!d.contractor || !d.contractor.name) return d;
  const out = { ...d, registry: licenceOnly(d.registry), registrations: [] };
  // contractor_relationships carries no market; Raleigh is the only NC market.
  if (d.contractor.businessState === 'NC') {
    out.subsHired = [];
    out.gcsWorkedFor = [];
    out.relationshipsHidden = PIN_NOTE;
  }
  return out;
}

function leads(d) {
  const byDate = (a, b) => String(b.issuedOn || b.filed_date || '').localeCompare(String(a.issuedOn || a.filed_date || ''));
  return { ...d, ranking: 'issue date', leads: d.leads.map(({ score: _s, trade_scores: _t, ...l }) => l).sort(byDate) };
}

function early(d) {
  if (!d.filings) return d;
  return {
    ...d,
    filings: d.filings.map((r) => ({
      ...r,
      issueForecast: null,
      builderSubs: [],
      filer: r.filer ? { ...r.filer, role: 'unknown', basis: 'Business named on the application' } : r.filer,
    })),
  };
}

function momentum(d) {
  if (!d.builders) return d;
  const builders = d.builders.map(({ trend: _t, applications: _a, ...b }) => b)
    .sort((a, b) => b.recent - a.recent || (b.prior ?? 0) - (a.prior ?? 0) || a.builder.id - b.builder.id);
  const pin = d.filters && d.filters.source === RALEIGH;
  return { ...d, counts: null, hasApplications: false, builders: pin ? builders.map((b) => ({ ...b, topSubs: [] })) : builders };
}

function gcs(d) {
  if (!d.filters || d.filters.source !== RALEIGH) return d;
  return { ...d, gcs: [], baseline: { ...d.baseline, repeatRate: null, topSubs: [] }, jobLinksHidden: PIN_NOTE };
}

function overview(d) {
  if (d.source !== RALEIGH) return d;
  return {
    ...d,
    repeatHiring: {},
    topGcs: (d.topGcs || []).map((g) => ({ ...g, subsHired: null, linkedJobs: null })),
    recent: (d.recent || []).map((r) => ({ ...r, trades: null })),
    jobLinksHidden: PIN_NOTE,
  };
}

const imagery = () => ({});

const FILTERS = { job, contractor, leads, early, momentum, gcs, overview, imagery };

// Unmeasured (owner, 2026-11-15): values from a second source whose accuracy
// against that source has never been measured. Stored, not shown, unless
// SHOW_UNMEASURED=1 (src/display_policy.js). Map points by Census match are
// held back in the queries themselves (locationSql).
const UNMEASURED_NOTE = 'Appraiser property facts and state licence details are not shown: their accuracy against the appraiser and the licence board has not been measured yet.';
// Job links (owner, 2026-11-15, ADR-33): which trade permits and subs belong
// to a building job rests on the job key each city publishes (base, master or
// application number). The keys are copied faithfully, but whether each key
// denotes exactly one job was never hand-checked, so nothing built on them is
// shown in any market: trade permits on a job, a GC's subs and repeat-hire
// rates, subs on a builder's jobs, and "no trade permit on record" lists.
const JOB_LINKS_NOTE = 'Which subcontractors worked on which job is not shown: the links between building and trade permits have not been hand-checked yet.';
const UNMEASURED = {
  job: (d) => ({ ...d, property: null, gcRegistry: [], unmeasuredHidden: UNMEASURED_NOTE,
    related: [], gcHiring: null, tradePermitIssued: null, jobLinksHidden: d.jobLinksHidden || JOB_LINKS_NOTE }),
  contractor: (d) => (d.contractor ? { ...d, registry: [], unmeasuredHidden: UNMEASURED_NOTE,
    subsHired: [], gcsWorkedFor: [], relationshipsHidden: d.relationshipsHidden || JOB_LINKS_NOTE } : d),
  gcs: (d) => ({ ...d, gcs: [], baseline: d.baseline ? { ...d.baseline, repeatRate: null, topSubs: [] } : d.baseline, jobLinksHidden: d.jobLinksHidden || JOB_LINKS_NOTE }),
  overview: (d) => ({
    ...d,
    repeatHiring: {},
    topGcs: (d.topGcs || []).map((g) => ({ ...g, subsHired: null, linkedJobs: null })),
    recent: (d.recent || []).map((r) => ({ ...r, trades: null })),
    jobLinksHidden: d.jobLinksHidden || JOB_LINKS_NOTE,
  }),
  momentum: (d) => (d.builders ? { ...d, builders: d.builders.map((b) => ({ ...b, topSubs: [] })), jobLinksHidden: d.jobLinksHidden || JOB_LINKS_NOTE } : d),
  leads: (d) => ({ ...d, leads: [], jobLinksHidden: d.jobLinksHidden || JOB_LINKS_NOTE }),
};

/** Strips class C fields unless SHOW_INFERENCES=1, and unmeasured ones unless SHOW_UNMEASURED=1. */
function filter(kind, body, env = process.env) {
  if (!body || body.status) return body;
  let out = body;
  if (!showInferences(env)) {
    out = FILTERS[kind](out);
    if (kind !== 'imagery') out = { ...out, inferencesHidden: true };
  }
  if (!showUnmeasured(env) && UNMEASURED[kind]) out = UNMEASURED[kind](out);
  return out;
}

module.exports = { filter, showInferences, PIN_NOTE, UNMEASURED_NOTE, JOB_LINKS_NOTE };
