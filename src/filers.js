// Who filed an Austin building application, and what kind of business it is
// (ADR-19). Pure functions; ingest/filers.js does the reads and writes.
//
// The plan-review feed (n8ck-xkda) names organisations in two contact fields,
// applicant_organization_name and other_organization_name, before any
// contractor is on record. Those are builders, owners' companies and permit
// expediters ("Waterloo Permits LLC *MAIN*"). Which field carries the builder
// is not documented, so both are read and each organisation is classified on
// evidence, never by field:
//
// - expediter: the name says so (permit, expediting, filing), or it filed for
//   many building permits that other contractors pulled;
// - builder: the same business pulled most of the building permits its
//   filings led to, or it already appears in our data as the contractor on an
//   Austin building permit;
// - unknown: anything else. Shown as "filed by", with no role claimed.
//
// Rule 5 (CLAUDE.md): owner names and individual-looking names are stored but
// never shown. An organisation equal to the owner organisation is the owner,
// so it is not stored as a filer at all.

const { normalizeName, partyKind, isOwnerBuilder } = require('./contractors.js');

const CLASSIFIER_VERSION = 'filers-v1';
const FIELDS = ['applicant_organization_name', 'other_organization_name'];

// AMANDA account suffixes ("*MAIN*", "**MAIN") mark a firm's main account.
const ACCOUNT_MARK = /\*+\s*main\s*\**/gi;
const EXPEDITER_WORDS = /\b(permit|permits|permitting|expedit\w*|filings?|plans for permits)\b/i;
const PLACEHOLDERS = new Set(['', 'main', 'redacted', 'none', 'na', 'n a', 'tbd', 'unknown', 'self']);

// Behavioural thresholds, on building permits linked to the org's filings
// through masterpermitnum = folderrsn (permit_links, ADR-16).
const EXPEDITER_MIN_LINKED = 5;
const EXPEDITER_MIN_DISTINCT = 3;
const EXPEDITER_MAX_SELF_SHARE = 0.2;
const BUILDER_MIN_LINKED = 2;
const BUILDER_MIN_SELF_SHARE = 0.5;

/** The organisation name as a person would read it, without account marks. */
function cleanOrgName(raw) {
  return String(raw ?? '').replace(ACCOUNT_MARK, ' ').replace(/\s+/g, ' ').trim().replace(/[\s,;-]+$/, '');
}

/**
 * The filer organisations on one plan-review payload: [{ field, raw, name, key }].
 * Placeholders, owner markers ("Owner") and anything equal to the owner
 * organisation are dropped. The same organisation in both fields is kept once.
 */
function filersOf(payload) {
  const p = payload || {};
  const ownerKey = normalizeName(cleanOrgName(p.owner_organization_name));
  const out = [];
  for (const field of FIELDS) {
    const raw = p[field];
    const name = cleanOrgName(raw);
    const key = normalizeName(name);
    if (PLACEHOLDERS.has(key) || isOwnerBuilder(name)) continue;
    if (ownerKey && key === ownerKey) continue;
    if (out.some((o) => o.key === key)) continue;
    out.push({ field, raw: String(raw), name, key });
  }
  return out;
}

/**
 * builder | expediter | unknown, with the basis in words.
 *
 * @param {object} s
 * @param {string} s.name            display name
 * @param {number} s.linked          building permits linked to this org's filings
 * @param {number} s.self            of those, pulled by a contractor with the same name
 * @param {number} s.distinct        distinct building contractors on those permits
 * @param {boolean} s.knownBuilder   the name equals a contractor on an Austin building permit
 */
function classify({ name, linked = 0, self = 0, distinct = 0, knownBuilder = false }) {
  if (EXPEDITER_WORDS.test(name || '')) return { role: 'expediter', basis: 'name says permit or expediting service' };
  const share = linked ? self / linked : null;
  if (linked >= EXPEDITER_MIN_LINKED && distinct >= EXPEDITER_MIN_DISTINCT && share < EXPEDITER_MAX_SELF_SHARE) {
    return { role: 'expediter', basis: `filed for ${linked} building permits pulled by ${distinct} other contractors` };
  }
  if (linked >= BUILDER_MIN_LINKED && share >= BUILDER_MIN_SELF_SHARE) {
    return { role: 'builder', basis: `pulled ${self} of the ${linked} building permits its filings led to` };
  }
  if (knownBuilder && !(linked >= BUILDER_MIN_LINKED && share < BUILDER_MIN_SELF_SHARE)) {
    return { role: 'builder', basis: 'same name as the contractor on Austin building permits' };
  }
  return { role: 'unknown', basis: linked ? `pulled ${self} of ${linked} linked building permits` : 'no building permit linked yet' };
}

/**
 * Whether a filer may be shown (rule 5). A name that reads like a business is
 * shown; a name that reads like a person ("Taylor Morrison") is shown only
 * when the same name is a business-kind contractor on building permits.
 */
function filerKind(name, contractorKind) {
  const k = partyKind(name);
  if (k === 'business') return 'business';
  return contractorKind === 'business' ? 'business' : k;
}

/** The one filer to show for a filing: a builder first, then an expediter, then unknown. */
function pickFiler(filers) {
  const rank = { builder: 0, expediter: 1, unknown: 2 };
  return (filers || []).filter((f) => f.partyKind === 'business')
    .sort((a, b) => rank[a.role] - rank[b.role] || String(a.key).localeCompare(String(b.key)))[0] || null;
}

// Home and context segments, on the plan-review sub_type ("R- 101 Single
// Family Houses"). Census building classes as in the P0 backtest. The
// patterns run in JS and in Postgres (~*), so no \\b: Postgres reads it as
// a backspace, not a word boundary.
const SEGMENTS = {
  homes: { label: 'New homes', pattern: '^R-\\s*10[1-4](\\s|$)' },
  apartments: { label: 'New apartments (5+ units)', pattern: '^R-\\s*105(\\s|$)' },
  commercial: { label: 'New commercial buildings', pattern: '^C-\\s*(21[34]|3(1[89]|2[0-8]))(\\s|$)' },
};

function segmentOf(permitType) {
  for (const [k, s] of Object.entries(SEGMENTS)) if (new RegExp(s.pattern, 'i').test(permitType || '')) return k;
  return null;
}

module.exports = {
  CLASSIFIER_VERSION, FIELDS, SEGMENTS, cleanOrgName, filersOf, classify, filerKind, pickFiler, segmentOf,
  EXPEDITER_MIN_LINKED, BUILDER_MIN_LINKED,
};
