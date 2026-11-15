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

module.exports = { showUnmeasured, locationSql, SHOWN_LOCATION_METHODS };
