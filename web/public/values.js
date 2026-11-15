/* How a declared value is worded on every screen (ADR-34, ADR-35).
 *
 * Sources copy one project's total onto each of its permits: Austin lists
 * $830,000,000 on 77 permits filed the same day (pergolas, a gatehouse, a
 * garage); Miami-Dade lists $580,000,000 on "LIGHT POLES" and "LOW VOLTAGE
 * CCTVS" at one address. The server counts, within one source, the permits
 * with the same value at the same address, or filed the same day when the
 * value is $1M or more (permits.valuation_repeats, migration 039). When that
 * count is above 1 the value is still shown as the source gives it, but never
 * as this permit's own cost.
 *
 * Loaded by index.html and the pilot pages; required by values.test.js.
 */
(function (root) {
  const fmt = (v) => `$${Math.round(Number(v)).toLocaleString('en-US')}`;
  const repeats = (n) => (Number(n) > 1 ? Number(n) : 0);

  /** Short suffix for cards and tables: "on 77 permits", or ''. */
  const repeatSuffix = (n) => (repeats(n) ? `on ${repeats(n)} permits` : '');

  /** The sentence for a hover title or a detail row, or ''. */
  function repeatNote(v, n) {
    if (!repeats(n) || v == null) return '';
    return `The source gives the same declared value, ${fmt(v)}, on ${repeats(n)} permits (same address, or filed the same day). `
      + 'It is the project\'s figure repeated on each permit, not this permit\'s own cost.';
  }

  /** Plain text: "$580,000,000", "$580,000,000 (same value on 4 permits)" or the missing word. */
  function valueText(v, n, missing = 'not published') {
    if (v == null) return missing;
    return repeats(n) ? `${fmt(v)} (same value on ${repeats(n)} permits)` : fmt(v);
  }

  const api = { repeatSuffix, repeatNote, valueText };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Values = api;
})(typeof window !== 'undefined' ? window : globalThis);
