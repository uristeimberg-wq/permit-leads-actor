// Schema-drift detection for a source (ADR-14). Pure: given the field names a
// source returned before and the raw rows of this run, says what changed.
//
// Socrata omits null fields from each row, so a rarely filled column can be
// absent from a whole run without anything having changed. Two guards:
// - a field counts as gone only if we saw it before AND the run is large
//   enough (MIN_ROWS) that its absence means something;
// - only fields the source's fieldMap reads are checked for removal. Other
//   columns coming and going is recorded as info, never as an alarm.

const MIN_ROWS = 500;

// Losing one of these breaks the product, not just a column on a page.
const CRITICAL = new Set(['permitNumber', 'filedDate', 'contractorName', 'contractorPhone', 'street', 'address']);

/** Source field names the adapter reads, as [{key, field}] (arrays flattened). */
function mappedFields(fieldMap = {}) {
  const out = [];
  for (const [key, spec] of Object.entries(fieldMap)) {
    for (const field of Array.isArray(spec) ? spec : [spec]) {
      if (typeof field === 'string') out.push({ key, field });
    }
  }
  return out;
}

/**
 * @param {string[]|null} previous field names stored for the source, or null on first run
 * @param {object[]} rows raw rows from this run
 * @param {object} fieldMap the source's fieldMap
 * @returns {{fields: string[], added: string[], missing: {field, key, severity}[], checked: boolean}}
 *   fields: the union to store (previous plus anything new; never shrinks, so a
 *   rare column is not "added" again every day)
 */
function detectDrift(previous, rows, fieldMap) {
  const seen = new Set();
  for (const row of rows) for (const k of Object.keys(row || {})) seen.add(k);
  const prev = new Set(previous || []);
  const added = previous ? [...seen].filter((f) => !prev.has(f)).sort() : [];
  const checked = Boolean(previous) && rows.length >= MIN_ROWS;
  const missing = checked
    ? mappedFields(fieldMap)
      .filter(({ field }) => prev.has(field) && !seen.has(field))
      .map(({ key, field }) => ({ key, field, severity: CRITICAL.has(key) ? 'error' : 'warning' }))
    : [];
  return { fields: [...new Set([...prev, ...seen])].sort(), added, missing, checked };
}

module.exports = { MIN_ROWS, CRITICAL, mappedFields, detectDrift };
