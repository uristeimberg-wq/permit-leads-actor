// Estimates built from our own permit history (ADR-21). Pure functions: the
// queries in db/pilot_queries.js gather the history, these turn it into a
// window, and the screens label every result an estimate, never a fact.
//
// Three estimates:
//
// 1. issueForecast: when a filing still in review is likely to be issued.
//    Comparables are building permits issued in the last 12 months in the
//    same market (and the same census class where the source publishes one),
//    measured from the city's own application date to its issue date. The
//    estimate is conditional on the filing's age: a case already 90 days old
//    is compared only with cases that were still open at 90 days.
// 2. tradeTiming: on an issued building permit with no permit for a trade
//    yet, whether one is likely to follow and when. Comparables are earlier
//    jobs observed for a full horizon (180 days), the builder's own when it
//    has enough, the market's otherwise.
// 3. momentum: whether a builder's volume is rising, from two equal windows
//    of issued building permits, withheld when our history does not cover
//    the earlier window.
//
// Every result carries its basis (what was compared, and how many), so the
// screen can show the evidence beside the estimate (CLAUDE.md rule 6).

const MIN_COMPARABLES = 20;          // issue forecast: fewer and no window is shown
const MIN_TRADE_COMPARABLES = 8;     // trade timing: the builder's own history
const MIN_MARKET_TRADE = 30;         // trade timing: market fallback
const TRADE_HORIZON_DAYS = 180;      // a job counts as "no trade permit" after this long
const BAND = [0.2, 0.8];             // the middle 60% of comparables
const MOMENTUM_WINDOW_DAYS = 90;
const MOMENTUM_MIN_RECENT = 3;

/** Nearest-rank quantile of an ascending array of integers. */
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

const clean = (xs) => xs.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);

/**
 * When a filing aged `ageDays` is likely to be issued, from `durations`
 * (days from application to issue of comparable permits). Days are counted
 * from today.
 *   status 'ok'      : lowDays..highDays is the middle 60% of comparables
 *                      still open at this age; midDays is the median
 *   status 'thin'    : too few comparables in total
 *   status 'overdue' : too few comparables were still open this late; the
 *                      filing is older than `pastShare` of them took
 */
function issueForecast(durations, ageDays, { min = MIN_COMPARABLES } = {}) {
  const all = clean(durations);
  const age = Math.max(0, Math.floor(ageDays || 0));
  if (all.length < min) return { status: 'thin', n: all.length, ageDays: age };
  const open = all.filter((d) => d > age);
  const pastShare = 1 - open.length / all.length;
  if (open.length < min) return { status: 'overdue', n: all.length, nAtAge: open.length, ageDays: age, pastShare };
  return {
    status: 'ok', n: all.length, nAtAge: open.length, ageDays: age,
    lowDays: quantile(open, BAND[0]) - age, midDays: quantile(open, 0.5) - age, highDays: quantile(open, BAND[1]) - age,
    // The plain median for all comparables, as context for the age effect.
    typicalDays: quantile(all, 0.5),
  };
}

/**
 * Whether a trade permit is likely to follow on a job whose building permit
 * was issued `sinceBpDays` ago, and when.
 * `lags`: for each comparable job observed for the full horizon, the days
 * from building permit to the first permit for the trade, or null when none
 * came within the horizon.
 *   status 'ok'   : likelihood = later / (later + none) among comparables with
 *                   no trade permit by this age; window in days from today
 *   status 'thin' : too few comparables
 *   status 'late' : past the horizon, or too few comparables still waiting
 */
function tradeTiming(lags, sinceBpDays, { min = MIN_TRADE_COMPARABLES, horizon = TRADE_HORIZON_DAYS } = {}) {
  const age = Math.max(0, Math.floor(sinceBpDays || 0));
  const got = clean(lags.filter((x) => x != null)).filter((x) => x <= horizon);
  const none = lags.length - got.length;
  const n = lags.length;
  if (n < min) return { status: 'thin', n, ageDays: age };
  const later = got.filter((x) => x > age);
  const waiting = later.length + none;
  const base = { n, withTrade: got.length, uptake: got.length / n, typicalDays: quantile(got, 0.5), ageDays: age };
  if (age >= horizon || waiting < min) return { status: 'late', ...base, waiting };
  const likelihood = later.length / waiting;
  if (!later.length) return { status: 'ok', ...base, waiting, likelihood, lowDays: null, midDays: null, highDays: null };
  return {
    status: 'ok', ...base, waiting, likelihood,
    lowDays: quantile(later, BAND[0]) - age, midDays: quantile(later, 0.5) - age, highDays: quantile(later, BAND[1]) - age,
  };
}

/**
 * Volume trend from two equal windows of building jobs. `historyCovers` is
 * false when our history starts after the earlier window does: the change
 * is then withheld rather than reported as growth from zero (rule 7).
 * `firstSeenRecently`: the builder's first permit in our data falls in the
 * recent window, so growth from zero means new to the market.
 */
function momentum(recent, prior, { historyCovers = true, firstSeenRecently = false, minRecent = MOMENTUM_MIN_RECENT } = {}) {
  if (!historyCovers) return { trend: 'unknown', reason: 'history', recent, prior: null, change: null };
  const change = recent - prior;
  const ratio = prior > 0 ? recent / prior : null;
  let trend = 'steady';
  // From zero: new to our data, or back after a quiet spell.
  if (prior === 0 && recent >= minRecent) trend = firstSeenRecently ? 'new' : 'rising';
  else if (recent >= minRecent && change >= 3 && ratio >= 1.5) trend = 'rising';
  else if (prior >= minRecent && -change >= 3 && ratio <= 0.5) trend = 'slowing';
  return { trend, recent, prior, change, ratio };
}

module.exports = {
  MIN_COMPARABLES, MIN_TRADE_COMPARABLES, MIN_MARKET_TRADE, TRADE_HORIZON_DAYS, BAND, MOMENTUM_WINDOW_DAYS, MOMENTUM_MIN_RECENT,
  quantile, issueForecast, tradeTiming, momentum,
};
