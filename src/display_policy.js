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

// One declared value on several permits (ADR-35). Sources copy a project's
// total onto each of its permits: Austin $830M on 77 permits filed one day
// (pergolas, a gatehouse), Miami-Dade $580M on "LIGHT POLES" and "LOW VOLTAGE
// CCTVS" at one address. The value is shown as the source gives it, with the
// count, so no screen presents it as that permit's own cost. Counted within
// one source: same value and same address, or same value filed the same day
// when it is $1M or more (a round $50K filed the same day is a coincidence).
const REPEAT_SAME_DAY_MIN = 1000000;
const valueRepeatsSql = (alias) => `(SELECT count(*)::int FROM permits vr
   WHERE vr.source_area = ${alias}.source_area AND vr.valuation = ${alias}.valuation
     AND (upper(trim(vr.address)) = upper(trim(${alias}.address))
          OR (vr.filed_date = ${alias}.filed_date AND ${alias}.valuation >= ${REPEAT_SAME_DAY_MIN})))`;

module.exports = { showUnmeasured, locationSql, SHOWN_LOCATION_METHODS, valueRepeatsSql, REPEAT_SAME_DAY_MIN };
