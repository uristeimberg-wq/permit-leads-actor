// Canonical lifecycle stage of a filing (ADR-16, docs/DATA_MODEL.md
// "Lifecycle model"). Each source maps its own status words to one stage in
// its `lifecycle.statuses` table (src/sources.js); the tables are reviewed in
// pull requests, which is what makes them the reviewed vocabulary. A status
// a source has not mapped is `unknown` and is reported (rule 3); nothing is
// inferred from wording that merely looks similar across sources.
//
// This is finer than status_stage (src/status.js), which stays for the
// existing filters: "Approved" on an Austin plan-review case means the plans
// are approved, which is not the same as a permit being issued.

const STAGES = [
  'pre_application', 'submitted', 'in_review', 'corrections', 'approved', 'issued', 'inspections', 'completed',
  'expired', 'withdrawn', 'cancelled', 'denied', 'unknown',
];

// Sources with no status column derive status_stage from dates (Miami-Dade);
// that derivation is mapped here, once, for those sources only.
const FROM_DERIVED = { approved: 'issued', finished: 'completed', cancelled: 'cancelled' };

const key = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * @param {object} source a SOURCES entry
 * @param {string|null} statusRaw the source's own wording
 * @param {string} [derivedStage] status_stage from deriveStatus(), for sources with no status column
 * @returns {string} one of STAGES
 */
function lifecycleStage(source, statusRaw, derivedStage) {
  const lc = source && source.lifecycle;
  if (!lc) return 'unknown';
  // A derived source's status_raw is our own label for its dates, so the
  // derived stage is what is mapped.
  if (lc.derived) return (derivedStage && FROM_DERIVED[derivedStage]) || 'unknown';
  if (statusRaw == null || String(statusRaw).trim() === '') return 'unknown';
  return (lc.statuses && lc.statuses[key(statusRaw)]) || 'unknown';
}

/** Every mapped stage must be a known stage: a typo would silently become a new stage. */
function validateVocabulary(slug, source) {
  const lc = source.lifecycle;
  if (!lc) return [];
  return Object.entries(lc.statuses || {})
    .filter(([raw, stage]) => !STAGES.includes(stage) || raw !== key(raw))
    .map(([raw, stage]) => `${slug}: "${raw}" -> "${stage}"`);
}

module.exports = { STAGES, lifecycleStage, validateVocabulary, statusKey: key };
