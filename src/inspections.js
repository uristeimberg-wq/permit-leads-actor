// Inspections (migration 033, docs/DATA_MODEL.md "Inspections"): one row per
// inspection a building department publishes, with its result as published
// and every result change kept as history. The two open layers found on
// 2026-11-15 (recon/lifecycle_scan.js) publish a rolling window only (Raleigh:
// today's and yesterday's schedule; Miami-Dade: about a week), so the daily
// read is what builds the record. Pure functions here; SQL in
// ingest/inspections.js.
//
// A source in src/sources.js has `kind: 'inspections'` and an `inspections`
// block naming the source's own columns. Every column was read off the live
// layer (rules 1 and 10). Names, emails and phones are never requested:
// `outFields` lists the columns the connector reads.
//
// The result class is a lookup of the source's own wording (`results`), the
// same way permit statuses map to stages. It is not an inference: a wording
// not in the table is 'unknown' and reported (rule 3). The raw wording is
// always stored next to it. A result is a fact about an inspection, never a
// claim about what anyone needs (no intent).

const { toIsoDate } = require('./dates.js');

const RESULT_CLASSES = ['approved', 'partial', 'rejected', 'not_ready', 'not_inspected', 'cancelled', 'scheduled', 'other', 'unknown'];
const FIELDS = ['permitNumber', 'permitType', 'inspectionType', 'result', 'scheduledOn', 'completed', 'address'];

const key = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const clean = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
};

function resultClass(source, raw) {
  const r = key(raw);
  if (!r) return 'unknown';
  return (source.inspections.results || {})[r] || 'unknown';
}

/**
 * Maps one raw row to an inspection, or null when its first key part or its
 * permit number is missing. `keyParts` builds the inspection key from several columns where the
 * source has no inspection id (Miami-Dade).
 */
function mapInspection(source, row) {
  const p = source.inspections;
  const f = p.fields;
  const parts = p.keyParts.map((k) => {
    const v = row[k];
    return typeof v === 'number' && /date|scheduled/i.test(k) ? toIsoDate(v) : clean(v);
  });
  // The first part (the permit or the inspection id) is required. A later
  // part the source leaves blank is '-': the first daily read (2026-11-15)
  // skipped 755 Miami-Dade rows whose staff number or order was blank.
  if (parts[0] == null) return null;
  for (let i = 1; i < parts.length; i += 1) if (parts[i] == null) parts[i] = '-';
  const permitNumber = clean(row[f.permitNumber]);
  if (!permitNumber) return null;
  const completedRaw = f.completed ? clean(row[f.completed]) : null;
  const result = clean(row[f.result]);
  return {
    inspectionKey: parts.join(' | '),
    permitNumber,
    permitType: f.permitType ? clean(row[f.permitType]) : null,
    inspectionType: clean(row[f.inspectionType]),
    result,
    resultClass: resultClass(source, result),
    scheduledOn: toIsoDate(row[f.scheduledOn]),
    completed: completedRaw == null ? null : /^(true|1|yes)$/i.test(completedRaw),
    address: f.address ? clean(row[f.address]) : null,
  };
}

/** Problems in an inspections block that would let a typo pass silently. */
function validateInspections(slug, source) {
  const p = source.inspections;
  if (!p || !p.fields) return [`${slug}: kind 'inspections' needs an inspections.fields block`];
  const problems = [];
  for (const k of ['permitNumber', 'inspectionType', 'result', 'scheduledOn']) if (!p.fields[k]) problems.push(`${slug}: inspections.fields.${k} is required`);
  for (const k of Object.keys(p.fields)) if (!FIELDS.includes(k)) problems.push(`${slug}: unknown inspections field "${k}"`);
  if (!Array.isArray(p.keyParts) || !p.keyParts.length) problems.push(`${slug}: inspections.keyParts is required`);
  if (!p.link || !p.link.to || !p.link.measured) problems.push(`${slug}: inspections.link needs a target and a measured link rate`);
  for (const [raw, cls] of Object.entries(p.results || {})) {
    if (!RESULT_CLASSES.includes(cls) || cls === 'unknown') problems.push(`${slug}: result "${raw}" -> unknown class "${cls}"`);
    if (raw !== key(raw)) problems.push(`${slug}: result key "${raw}" must be lower case with single spaces`);
  }
  if (!Array.isArray(source.outFields) || !source.outFields.length) problems.push(`${slug}: outFields must list the columns read (no names or contacts)`);
  for (const col of [...Object.values(p.fields), ...(p.keyParts || [])]) {
    if (source.outFields && !source.outFields.includes(col)) problems.push(`${slug}: "${col}" is mapped but not in outFields`);
  }
  for (const col of source.outFields || []) {
    if (/name|email|phone|contact|super|dir_|photo/i.test(col) && !/^Inspection/.test(col)) problems.push(`${slug}: outFields "${col}" looks like a person's name or contact`);
  }
  return problems;
}

module.exports = { mapInspection, validateInspections, resultClass, RESULT_CLASSES };
