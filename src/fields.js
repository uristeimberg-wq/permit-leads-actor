// Field-level provenance and conflicts (ADR-23, DATA_ENGINE_PLAN 6.3).
//
// Pure functions. ingest/fields.js turns appraiser parcels and the building
// facts of the permits filed on them into field_observations (migration 023),
// and writes a field_conflicts row wherever two sources disagree. Nothing is
// overwritten: the resolved value is computed here, over the observations.
//
// Rules:
//   - Only attributes of an entity, not of one filing. A permit's own fields
//     keep row-level provenance (raw_record_id); its units and floors become
//     property observations because the appraiser publishes the same thing.
//   - Confidence is a tier (official, high, medium, low), never a decimal.
//   - Resolution is deterministic: source precedence, then tolerance. Two
//     observations of the same precedence that disagree leave the value
//     unresolved (NULL) with an open conflict. We do not pick one (rule 1).

const crypto = require('node:crypto');

// v2 (2026-11-14): only building permits observe a property's units and
// floors. Under v1, trade permits (which state their own job's scope, mostly
// "1") made 97% of the 2,465 open conflicts on the first live run.
const RULE_VERSION = 'fields-v2';

// Appraiser providers (parcels.provider) and the county whose parcel keys
// they publish. One appraiser per county today.
const APPRAISERS = {
  'miami-dade-pa': { county: 'miami-dade-county-fl' },
  'travis-cad': { county: 'travis-county-tx' },
  'wake-parcels': { county: 'wake-county-nc' },
};

// Source precedence: lower wins. The appraiser roll beats a permit for what a
// property is today. (The plan's "permit wins on a new build, because the roll
// lags construction" needs a reliable new-construction flag on every market;
// until then the permit's value stays visible as the losing observation.)
const RANK = { appraiser: 1, permit: 2 };

// The property vocabulary. `parcel` / `permit` name the column each side
// supplies; `tolerance` is relative (0.10 = within 10%); 0 means exact.
// Permit `building_sqft` is not compared with heated area: the sources define
// it differently (Austin's is the existing building, not living area).
const FIELDS = {
  year_built: { type: 'int', parcel: 'year_built', tolerance: 0 },
  heated_sqft: { type: 'num', parcel: 'heated_sqft', tolerance: 0.10 },
  lot_sqft: { type: 'num', parcel: 'lot_sqft', tolerance: 0.10 },
  units: { type: 'int', parcel: 'units', permit: 'units', tolerance: 0 },
  floors: { type: 'num', parcel: 'floors', permit: 'floors', tolerance: 0 },
  land_use: { type: 'text', parcel: 'land_use' },
  assessed_value: { type: 'num', parcel: 'assessed_value', tolerance: 0 },
  land_value: { type: 'num', parcel: 'land_value', tolerance: 0 },
  improvement_value: { type: 'num', parcel: 'improvement_value', tolerance: 0 },
};

// What each appraiser publishes at all. A field outside its list is silent
// (no observation), not unknown.
const PUBLISHES = {
  'miami-dade-pa': ['year_built', 'heated_sqft', 'lot_sqft', 'units', 'floors', 'land_use', 'assessed_value'],
  'travis-cad': ['year_built', 'heated_sqft', 'lot_sqft', 'land_value', 'improvement_value'],
  'wake-parcels': ['year_built', 'heated_sqft', 'lot_sqft', 'units', 'land_use', 'assessed_value', 'land_value', 'improvement_value'],
};

function normalize(field, v) {
  if (v == null || v === '') return null;
  const t = FIELDS[field].type;
  if (t === 'text') return String(v).trim() || null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return t === 'int' ? Math.round(n) : n;
}

const valueHash = (v) => crypto.createHash('sha1').update(JSON.stringify(v === undefined ? null : v)).digest('hex').slice(0, 20);

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/**
 * One found parcels row -> observations. The appraiser's figures, joined to
 * the property by its own key: confidence high (plan 6.3 tier table). A NULL
 * the appraiser publishes for a field it carries is an observation of
 * "unknown", so a value that disappears is not kept as current.
 */
function parcelObservations(parcel) {
  const fields = PUBLISHES[parcel.provider];
  if (!fields || !parcel.found) return [];
  // The roll year is the source's own date when it has one; else the layer's
  // edit date.
  const asOf = parcel.assessment_year ? `${parcel.assessment_year}-01-01` : day(parcel.source_edited_at);
  return fields.map((field) => ({
    field,
    value: normalize(field, parcel[FIELDS[field].parcel]),
    sourceSlug: parcel.provider,
    sourceRef: parcel.parcel_key,
    rawRecordId: null,
    method: 'as_published',
    confidence: 'high',
    sourceAsOf: asOf,
    retrievedAt: parcel.fetched_at,
  }));
}

/**
 * One permit's building facts -> observations of the property it is filed on.
 * Medium: the value is published, but it describes the permit's job and is
 * attached to the property through the permit's parcel link. Only fields the
 * permit actually carries (a permit silent on floors says nothing).
 */
function permitObservations(facts) {
  const out = [];
  for (const [field, spec] of Object.entries(FIELDS)) {
    if (!spec.permit) continue;
    const value = normalize(field, facts[spec.permit]);
    if (value == null) continue;
    out.push({
      field,
      value,
      sourceSlug: facts.source_slug,
      sourceRef: facts.permit_number,
      rawRecordId: facts.raw_record_id,
      method: 'matched',
      confidence: 'medium',
      sourceAsOf: day(facts.issued_date || facts.filed_date),
      retrievedAt: facts.extracted_at,
    });
  }
  return out;
}

function agree(field, a, b) {
  if (a == null || b == null) return a == null && b == null;
  const tol = FIELDS[field].tolerance || 0;
  if (typeof a === 'number' && typeof b === 'number') {
    if (tol === 0) return a === b;
    return Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b));
  }
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * Resolve one field of one entity from its current observations
 * ({ id, value, role: 'appraiser'|'permit', confidence, sourceSlug, sourceRef }).
 * Returns { value, winnerId, conflict } where conflict is null or
 * { kind, status, observationIds, resolution }.
 */
function resolve(field, observations) {
  const usable = observations.filter((o) => o.confidence !== 'low' && o.value != null);
  if (!usable.length) return { value: null, winnerId: null, conflict: null };
  const top = Math.min(...usable.map((o) => RANK[o.role]));
  const best = usable.filter((o) => RANK[o.role] === top);
  const head = best[0];
  const ids = usable.map((o) => o.id).sort((a, b) => a - b);
  const say = (o) => `${o.sourceSlug} ${o.sourceRef} says ${o.value}`;
  if (best.some((o) => !agree(field, o.value, head.value))) {
    return {
      value: null,
      winnerId: null,
      conflict: { kind: 'disagree', status: 'open', observationIds: ids, resolution: `Unresolved: ${best.map(say).join('; ')}` },
    };
  }
  const losers = usable.filter((o) => !agree(field, o.value, head.value));
  if (!losers.length) return { value: head.value, winnerId: head.id, conflict: null };
  return {
    value: head.value,
    winnerId: head.id,
    conflict: {
      kind: 'disagree',
      status: 'auto_resolved',
      observationIds: ids,
      resolution: `${say(head)} (${head.role} precedence); also ${losers.map(say).join('; ')}`,
    },
  };
}

module.exports = { RULE_VERSION, APPRAISERS, RANK, FIELDS, PUBLISHES, normalize, valueHash, parcelObservations, permitObservations, agree, resolve };
