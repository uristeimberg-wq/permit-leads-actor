// What the screens may show beyond inferences (web/trust.js): values whose
// accuracy we have not measured against their own source stay stored and
// computed, but are not displayed (owner, 2026-11-15: no data from sources
// that are not verified or not supervised). SHOW_UNMEASURED=1 shows them
// again, for review. docs/DATA_TRUST_AUDIT.md lists each one and the
// measurement that would bring it back.

const showUnmeasured = (env = process.env) => env.SHOW_UNMEASURED === '1';

// Map points: the source's own point and the appraiser parcel's point (both
// on an official key) are shown; a Census point is interpolated along the
// street's address range, its error never measured, so it is not.
const SHOWN_LOCATION_METHODS = ['source', 'parcel'];
const locationSql = (alias = 'l', env = process.env) =>
  (showUnmeasured(env) ? 'TRUE' : `${alias}.method IN (${SHOWN_LOCATION_METHODS.map((m) => `'${m}'`).join(', ')})`);

// One declared value on several permits (ADR-35, ADR-36): sources copy a
// project's total onto each of its permits. permits.valuation_repeats and
// permits.valuation_first are stored (migration 039, refreshed by
// db/index.js upsertPermits); screens word a repeated value as the project's
// figure, and sorts, filters, sums and medians use only the first permit of
// each repeat group, so one figure counts once.
// SQL for "this permit's value, counted once": NULL on a repeat's later copies.
const countedValueSql = (alias = '') => `CASE WHEN ${alias ? `${alias}.` : ''}valuation_first THEN ${alias ? `${alias}.` : ''}valuation END`;

module.exports = { showUnmeasured, locationSql, SHOWN_LOCATION_METHODS, countedValueSql };
