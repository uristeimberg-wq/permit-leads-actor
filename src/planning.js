// Planning cases (pre-application signals, docs/DATA_MODEL.md "Planning
// cases"): site plans, subdivisions, development plans and utility
// allocations. They have a different shape from permits, so they get their
// own table (migration 025) and are linked to permits, never merged into them.
//
// A planning source in src/sources.js has `kind: 'planning'` and a `planning`
// block naming the source's own columns for each attribute. Every column was
// read off the live source (rule 1 and 10); an attribute the source does not
// publish is simply absent and stays NULL. Pure functions here; the SQL is in
// ingest/planning.js.

const { toIsoDate } = require('./dates.js');
const { lifecycleStage } = require('./lifecycle.js');
const { partyKind } = require('./contractors.js');

const CASE_KINDS = ['site_plan', 'subdivision', 'development_plan', 'zoning', 'variance', 'utility_allocation', 'other'];

// Attributes a `planning.fields` block may name, and how each value is read.
const TEXT = ['caseNumber', 'caseRef', 'caseType', 'status', 'address', 'parcel', 'propertyRef', 'officialRef', 'name', 'description', 'zoning', 'recordUrl'];
const DATES = ['filedOn', 'statusDate', 'decidedOn', 'expiresOn'];
const INTS = ['unitsProposed', 'unitsApproved', 'lotsProposed', 'lotsApproved', 'floorAreaSqft', 'flowGpd'];
const NUMS = ['acreage', 'lat', 'lng'];
const ATTRIBUTES = [...TEXT, ...DATES, ...INTS, ...NUMS];

// Placeholders these layers type where they mean "none" ("0" property ids,
// "N/A" process numbers, "_" status codes). They are NULL, never a value.
const PLACEHOLDERS = new Set(['', '0', 'n/a', 'na', 'none', '_', '-', 'null']);

const clean = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return PLACEHOLDERS.has(s.toLowerCase()) ? null : s;
};

/** A count the source states. 0 is a placeholder on these layers, so it is NULL, never "none". */
function toInt(v) {
  const s = clean(v);
  if (s == null) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function toNum(v) {
  const s = clean(v);
  if (s == null) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** First non-empty value over one column or a list of columns. */
function pick(row, field) {
  for (const f of [].concat(field)) {
    const v = row[f];
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
}

/**
 * The canonical kind of a case: a fixed kind for the source, or the source's
 * own type word looked up in its reviewed `caseKinds` table. A type word the
 * table does not hold is 'other' and reported, not guessed.
 */
function caseKindOf(planning, caseTypeRaw) {
  if (planning.caseKind) return planning.caseKind;
  const k = clean(caseTypeRaw);
  if (!k || !planning.caseKinds) return 'other';
  return planning.caseKinds[k.toLowerCase()] || 'other';
}

/**
 * One raw row -> one planning case. Returns null when the row has no case
 * number (it cannot be deduplicated, rule 2).
 */
function mapCase(source, row) {
  const p = source.planning;
  const f = p.fields;
  const out = {};
  for (const a of ATTRIBUTES) {
    if (!f[a]) { out[a] = null; continue; }
    const v = pick(row, f[a]);
    if (TEXT.includes(a)) out[a] = clean(v);
    else if (DATES.includes(a)) out[a] = toIsoDate(v);
    else if (INTS.includes(a)) out[a] = toInt(v);
    else out[a] = toNum(v);
  }
  if (p.point && row[p.point] && Array.isArray(row[p.point].coordinates)) {
    [out.lng, out.lat] = row[p.point].coordinates.map(Number);
  }
  // An address published in parts (Austin: number, prefix, name, type).
  if (!out.address && p.addressParts) {
    out.address = clean(p.addressParts.map((k) => clean(row[k])).filter(Boolean).join(' '));
  }
  if (!out.caseNumber) return null;
  if (p.addressMustStartWithNumber && out.address && !/^\d/.test(out.address)) out.address = null;
  if (p.recordUrlTemplate && out.caseNumber && !out.recordUrl) out.recordUrl = p.recordUrlTemplate.replace('{id}', encodeURIComponent(out.caseNumber));
  out.caseKind = caseKindOf(p, out.caseType);
  out.lifecycleStage = lifecycleStage(source, out.status);
  // Participants as published. Every name is stored; partyKind decides display
  // later (rule 5: an individual-looking name is never shown or exported).
  out.parties = [];
  for (const party of p.parties || []) {
    const name = clean(pick(row, party.field));
    if (!name) continue;
    out.parties.push({ role: party.role, name, partyKind: partyKind(name) });
  }
  return out;
}

/** Problems in a planning block that would let a typo pass silently. */
function validatePlanning(slug, source) {
  const problems = [];
  const p = source.planning;
  if (!p || !p.fields) return [`${slug}: kind 'planning' needs a planning.fields block`];
  if (!p.fields.caseNumber) problems.push(`${slug}: planning.fields.caseNumber is required`);
  for (const k of Object.keys(p.fields)) if (!ATTRIBUTES.includes(k)) problems.push(`${slug}: unknown planning field "${k}"`);
  if (p.caseKind && !CASE_KINDS.includes(p.caseKind)) problems.push(`${slug}: unknown caseKind "${p.caseKind}"`);
  for (const [raw, kind] of Object.entries(p.caseKinds || {})) {
    if (!CASE_KINDS.includes(kind)) problems.push(`${slug}: caseKinds "${raw}" -> unknown "${kind}"`);
    if (raw !== raw.toLowerCase().trim()) problems.push(`${slug}: caseKinds key "${raw}" must be lower case`);
  }
  for (const party of p.parties || []) if (!party.role || !party.field) problems.push(`${slug}: party needs role and field`);
  return problems;
}

module.exports = { mapCase, validatePlanning, caseKindOf, CASE_KINDS, ATTRIBUTES, toInt };
