// Response and row validation for the API adapters (Zod), so an upstream
// schema change is caught and recorded instead of silently mapping to NULLs.
//
// Two levels:
//   - the page envelope (Socrata: an array of objects; ArcGIS: an object with
//     `features`, or an `error`). A bad envelope throws an error whose message
//     starts with "schema:", which classifyError (ingest/raw.js) files as
//     error_class 'schema'. Nothing from that page is written.
//   - each row's key and date columns. A bad row is still stored raw (the
//     payload is the evidence), and the run records one 'validation' source
//     event with counts per column and a few samples. Mapping already turns
//     an unreadable date into NULL (src/dates.js), never a guess.

const { z } = require('zod');

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const rowObject = z.record(z.string(), z.unknown());

const socrataPage = z.array(rowObject);

const arcgisError = z.object({
  error: z.object({ code: z.union([z.number(), z.string()]).optional(), message: z.string().optional() }).passthrough(),
}).passthrough();
const arcgisFeatures = z.object({
  features: z.array(z.object({ attributes: rowObject }).passthrough()),
  exceededTransferLimit: z.boolean().optional(),
}).passthrough();
// An error body is checked as one, so a bad features page names its fault.
const isErrorBody = (b) => b && typeof b === 'object' && !Array.isArray(b) && 'error' in b;

function describe(issues) {
  return issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/** @throws {Error} 'schema: ...' when the page is not the shape the API documents */
function parsePage(kind, body, label) {
  const schema = kind === 'socrata' ? socrataPage : (isErrorBody(body) ? arcgisError : arcgisFeatures);
  const r = schema.safeParse(body);
  if (!r.success) {
    const preview = JSON.stringify(body).slice(0, 160);
    throw new Error(`schema: ${label} returned an unexpected ${kind} page (${describe(r.error.issues)}): ${preview}`);
  }
  // The untouched body, not Zod's copy: raw_records stores exactly what came back.
  return body;
}

// A key is a non-empty string or a number.
const keyValue = z.union([z.string().trim().min(1), z.number().finite()]);

// A date cell: missing, epoch milliseconds within Date's range (ArcGIS), or
// text that starts with an ISO or US date (Socrata, CSV).
const DATE_TEXT = /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/;
const dateValue = z.union([
  z.null(), z.undefined(),
  z.number().finite().refine((n) => Math.abs(n) <= 8.64e15 && !Number.isNaN(new Date(n).getTime()), 'epoch out of range'),
  z.string().refine((s) => s.trim() === '' || DATE_TEXT.test(s.trim()), 'not a date'),
]);

const DATE_KEYS = ['filedDate', 'submittedDate', 'statusDate'];

/** The columns to check for one source: its key, mapped dates and window fields. */
function rowColumns(source, windows = []) {
  const map = source.fieldMap || {};
  const key = typeof map.permitNumber === 'string' ? map.permitNumber : null;
  const dates = new Set();
  for (const k of DATE_KEYS) {
    for (const f of [].concat(map[k] || [])) if (typeof f === 'string') dates.add(f);
  }
  for (const w of windows) if (w && w.field && !w.field.startsWith(':')) dates.add(w.field);
  if (source.dateField) dates.add(source.dateField);
  if (source.updatedAtField) dates.add(source.updatedAtField);
  return { key, dates: [...dates] };
}

/**
 * @returns {{rows: number, invalid: number, byColumn: Object<string, number>, samples: object[]}}
 *   invalid counts rows with at least one bad column. A column a row does not
 *   carry is not an error (Socrata omits nulls).
 */
function validateRows(rows, source, { windows = [], maxSamples = 5 } = {}) {
  const { key, dates } = rowColumns(source, windows);
  const byColumn = {};
  const samples = [];
  let invalid = 0;
  for (const row of rows) {
    let bad = false;
    const note = (column, value) => {
      byColumn[column] = (byColumn[column] || 0) + 1;
      bad = true;
      if (samples.length < maxSamples) samples.push({ key: key ? row[key] ?? null : null, column, value: scalar.safeParse(value).success ? value : typeof value });
    };
    if (!rowObject.safeParse(row).success) { invalid += 1; byColumn['(row)'] = (byColumn['(row)'] || 0) + 1; continue; }
    if (key && !keyValue.safeParse(row[key]).success) note(key, row[key]);
    for (const f of dates) if (!dateValue.safeParse(row[f]).success) note(f, row[f]);
    if (bad) invalid += 1;
  }
  return { rows: rows.length, invalid, byColumn, samples };
}

/** 'error' when most rows are bad (a likely schema change), else 'warning'. */
function validationSeverity({ rows, invalid }) {
  return rows > 0 && invalid / rows > 0.5 ? 'error' : 'warning';
}

module.exports = { parsePage, validateRows, validationSeverity, rowColumns };
