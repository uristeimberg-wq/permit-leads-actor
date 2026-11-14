// Pure helpers for the fidelity check (recon/fidelity_check.js): does what we
// store and show still equal what the official source publishes today?
//
// Three comparisons per sampled permit, kept apart because each has its own fix:
//   1. source drift  - the live raw row vs the latest raw row we stored. A
//      difference means the city edited the record after we last fetched it.
//   2. pipeline      - our stored permit vs what today's code maps from the raw
//      row we stored. A difference is ours (stale rows, upsert rules, bugs).
//   3. shown vs live - our stored permit vs what today's code maps from the
//      live row. This is the number a customer cares about.
// Plus: the record is gone from the source (deleted, withdrawn or renumbered),
// and whether the next sync would catch a source edit (its date windows).
//
// No I/O here, so it tests offline (recon/fidelity.test.js).

const { canonicalJson } = require('../ingest/raw.js');
const { mapRows } = require('../src/adapters/socrata.js');
const { mapFeatures } = require('../src/adapters/arcgis.js');

// Permit columns compared against the mapped record, with the mapped key.
// Owner and applicant are left out: stored, never shown (rule 5).
const FIELDS = [
  ['permit_type', 'permitType'],
  ['work_description', 'workDescription'],
  ['valuation', 'valuation'],
  ['status_raw', 'statusRaw'],
  ['lifecycle_stage', 'lifecycleStage'],
  ['filed_date', 'filedDate'],
  ['submitted_on', 'submittedOn'],
  ['stage_since', 'stageSince'],
  ['address', 'address'],
  ['zip', 'zip'],
  ['contractor_name', 'contractorName'],
  ['contractor_phone', 'contractorPhone'],
  ['contractor_licence', 'contractorLicence'],
  ['permit_url', 'permitUrl'],
];

// ArcGIS bookkeeping columns: they move when a layer is re-published or a row
// is touched, without any fact on the permit changing. Counted, but kept apart
// from substantive edits.
const BOOKKEEPING = new Set([
  'OBJECTID', 'ObjectId', 'objectid', 'FID', 'EditDate', 'Editor', 'CreationDate', 'Creator',
  'last_edited_date', 'last_edited_user', 'created_date', 'created_user', 'GlobalID',
  // City of Miami re-numbers its row ID column when the layer is re-published.
  'ID',
]);

const SILENT = { info() {}, warn() {}, warning() {}, error() {}, debug() {} };

/** One value in a comparable form: blanks are null, dates are YYYY-MM-DD, numbers are numbers. */
function canon(v) {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** Columns where our stored permit and a mapped record disagree. */
function compareFields(stored, mapped, present) {
  const out = [];
  for (const [col, key] of FIELDS) {
    const ours = canon(stored[col]);
    const theirs = canon(mapped[key]);
    // Fields where at least one side has a value: both empty is not a check.
    if (present && (ours != null || theirs != null)) present.push(col);
    if (ours === theirs) continue;
    let kind = 'differs';
    if (ours == null) kind = 'missing_ours';
    else if (theirs == null) kind = 'kept_ours'; // the source has no value; we still show one
    out.push({ field: col, kind, ours, theirs });
  }
  return out;
}

/** Raw keys whose values differ between two raw rows (either side may lack the key). */
function diffRaw(stored, live) {
  const keys = new Set([...Object.keys(stored || {}), ...Object.keys(live || {})]);
  const changed = [];
  for (const k of keys) {
    if (canonicalJson(stored ? stored[k] : undefined) !== canonicalJson(live ? live[k] : undefined)) changed.push(k);
  }
  return changed.sort();
}

/** Today's code mapping one raw row (as stored in raw_records) to a permit. */
function mapOne(source, row) {
  if (source.type === 'arcgis') return mapFeatures([{ attributes: row }], source, { log: SILENT })[0];
  if (source.type === 'socrata') return mapRows([row], source, { log: SILENT })[0];
  throw new Error(`fidelity: unsupported source type ${source.type}`);
}

function toDate(v) {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The date windows a scheduled sync reads (ADR-11). */
function windowsOf(source) {
  if (source.syncWindows && source.syncWindows.length) return source.syncWindows;
  return source.dateField ? [{ field: source.dateField, days: 30 }] : [];
}

/** True when the next scheduled sync would fetch this live row again. */
function windowCatches(source, liveRow, now = new Date()) {
  return windowsOf(source).some((w) => {
    const d = toDate(liveRow[w.field]);
    return d != null && d.getTime() >= now.getTime() - w.days * 86400000;
  });
}

/** SQL / SoQL `field IN (...)` over keys; strings are quoted with '' escaping. */
function keyWhere(field, keys, numeric) {
  const lit = keys.map((k) => (numeric ? String(Number(k)) : `'${String(k).replace(/'/g, "''")}'`));
  return `${field} IN (${lit.join(',')})`;
}

/**
 * Verdict for one sampled permit.
 * @param {object} p {source, stored (permit row), storedRaw (payload|null), liveRows (payload[])}
 */
function judge({ source, stored, storedRaw, liveRows, now }) {
  if (!liveRows || liveRows.length === 0) return { found: false };
  // Several live rows under one key: prefer the one we stored, else the first.
  const storedJson = storedRaw ? canonicalJson(storedRaw) : null;
  const live = liveRows.find((r) => canonicalJson(r) === storedJson) || liveRows[0];
  const rawChanged = storedRaw ? diffRaw(storedRaw, live) : null;
  const substantive = rawChanged ? rawChanged.filter((k) => !BOOKKEEPING.has(k)) : null;
  const present = [];
  const shown = compareFields(stored, mapOne(source, live), present);
  const pipeline = storedRaw ? compareFields(stored, mapOne(source, storedRaw)) : null;
  return {
    found: true,
    multiple: liveRows.length > 1,
    rawChanged,
    substantive,
    caughtByWindow: windowCatches(source, live, now),
    shown,
    present,
    pipeline,
  };
}

/** Wilson 95% interval for k of n, as [low, high] shares. */
function wilson(k, n) {
  if (!n) return [null, null];
  const z = 1.96;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

module.exports = { FIELDS, BOOKKEEPING, canon, compareFields, diffRaw, mapOne, windowCatches, windowsOf, keyWhere, judge, wilson };
