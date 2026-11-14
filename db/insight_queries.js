// History behind the estimates (ADR-21, src/forecast.js): how long comparable
// permits took to be issued, and how long after a building permit each trade
// permit followed. Read-only. The answers change once a day with the sync, so
// each is memoised for an hour (off when API_CACHE=off, as in the tests).
//
// Comparables are always the source's own dates: the city's application date
// (permits.submitted_on) and its issue date (permit_parties.issued_on). Where a
// source publishes a census class on the building permit (Austin's
// `permit_class`, "R- 101 Single Family Houses"), it is read from the raw
// record the permit was taken from, so a new house is compared with new
// houses. permit_parties rows keep their raw record (ingest/prune.js).

const { query } = require('./index.js');
const { SEGMENTS } = require('../src/filers.js');
const F = require('../src/forecast.js');

// The raw field holding a building permit's census class, per issued feed.
const CLASS_FIELD = { 'austin-tx': 'permit_class' };
const LOOKBACK_DAYS = 365;

const memo = new Map();
const TTL_MS = 60 * 60 * 1000;
async function remember(key, compute) {
  if (process.env.API_CACHE === 'off') return compute();
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await compute();
  memo.set(key, { at: Date.now(), value });
  return value;
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const classSql = (source) => (CLASS_FIELD[source]
  ? `(SELECT rr.payload ->> '${CLASS_FIELD[source]}' FROM raw_records rr WHERE rr.id = pp.raw_record_id)` : 'NULL::text');

/**
 * Application-to-issue days for permits issued in the last 12 months in
 * `source`, grouped by kind (building, or the trade) and census class.
 * @returns {Promise<{kind: string, cls: string|null, days: number[]}[]>}
 */
function issueDurations(source) {
  return remember(`durations:${source}`, async () => {
    const { rows } = await query(`
      SELECT CASE WHEN pp.is_building THEN 'building' ELSE coalesce(pp.trade, 'other') END AS kind,
             ${classSql(source)} AS cls,
             array_agg(pp.issued_on - p.submitted_on) AS days
        FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id
       WHERE p.source_area = $1 AND pp.role = 'contractor'
         AND pp.issued_on >= current_date - $2::int AND p.submitted_on IS NOT NULL
         AND pp.issued_on >= p.submitted_on
       GROUP BY 1, 2`, [source, LOOKBACK_DAYS]);
    return rows.map((r) => ({ kind: r.kind, cls: r.cls, days: r.days.map(Number) }));
  });
}

/**
 * The narrowest comparable set with enough cases for a filing: the same
 * census class, then the same segment (new homes, apartments, commercial),
 * then every permit of that kind in the market.
 */
function pickComparables(groups, { kind, cls, segment }, min = F.MIN_COMPARABLES) {
  const ofKind = groups.filter((g) => g.kind === kind);
  const tries = [];
  if (cls) tries.push(['class', ofKind.filter((g) => g.cls && norm(g.cls) === norm(cls)), cls]);
  if (segment && SEGMENTS[segment]) {
    const re = new RegExp(SEGMENTS[segment].pattern, 'i');
    tries.push(['segment', ofKind.filter((g) => g.cls && re.test(g.cls)), SEGMENTS[segment].label.toLowerCase()]);
  }
  tries.push(['all', ofKind, null]);
  for (const [basis, gs, label] of tries) {
    const days = gs.flatMap((g) => g.days);
    if (days.length >= min || basis === 'all') return { basis, label, kind, days };
  }
  return null;
}

const addDays = (n) => (n == null ? null : new Date(Date.now() + n * 86400000).toISOString().slice(0, 10));

/**
 * The issue forecast for one filing, with its basis. `filing` has the
 * source's submitted date, the feed it would be issued in, its kind and its
 * census class (Austin plan-review sub type) or segment.
 */
async function forecastFiling(issuedSource, filing) {
  if (!filing.submittedOn) return { status: 'no_date' };
  const groups = await issueDurations(issuedSource);
  const comp = pickComparables(groups, filing);
  const age = Math.floor((Date.now() - new Date(`${String(filing.submittedOn).slice(0, 10)}T00:00:00Z`)) / 86400000);
  const f = F.issueForecast(comp ? comp.days : [], age);
  return {
    ...f,
    lowOn: addDays(f.lowDays), midOn: addDays(f.midDays), highOn: addDays(f.highDays),
    basis: comp ? { basis: comp.basis, label: comp.label, kind: comp.kind, source: issuedSource, lookbackDays: LOOKBACK_DAYS } : null,
  };
}

/**
 * Days from building permit to the first permit of each trade, for jobs
 * whose building permit was issued between 180 days and 18 months ago (so
 * each was watched for the full horizon). `gcId` narrows to one builder;
 * `cls` to one census class. A lag over the horizon reads as none.
 * @returns {Promise<Record<string, (number|null)[]>>} by trade
 */
function tradeLags(source, { gcId = null, cls = null } = {}) {
  return remember(`lags:${source}:${gcId}:${norm(cls)}`, async () => {
    const { rows } = await query(`
      WITH bp AS (
        SELECT pp.job_key, min(pp.issued_on) AS bp_on
          FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id
         WHERE pp.is_building AND pp.job_key IS NOT NULL AND p.source_area = $1
           AND pp.issued_on BETWEEN current_date - 545 AND current_date - $2::int
           AND ($3::bigint IS NULL OR pp.contractor_id = $3)
           AND ($4::text IS NULL OR lower(regexp_replace(${classSql(source)}, '\\s+', ' ', 'g')) = $4)
         GROUP BY pp.job_key
      ),
      tr AS (
        SELECT t.job_key, t.trade, min(t.issued_on) AS on_
          FROM permit_parties t JOIN permits p ON p.id = t.permit_id
         WHERE t.trade IS NOT NULL AND p.source_area = $1 AND t.job_key IN (SELECT job_key FROM bp)
         GROUP BY 1, 2
      )
      SELECT x.trade, array_agg(CASE WHEN tr.on_ IS NULL OR tr.on_ - bp.bp_on > $2::int THEN NULL
                                     ELSE greatest(tr.on_ - bp.bp_on, 0) END) AS lags
        FROM bp CROSS JOIN (VALUES ('electrical'), ('mechanical'), ('plumbing')) x(trade)
        LEFT JOIN tr ON tr.job_key = bp.job_key AND tr.trade = x.trade
       GROUP BY x.trade`, [source, F.TRADE_HORIZON_DAYS, gcId, cls ? norm(cls) : null]);
    return Object.fromEntries(rows.map((r) => [r.trade, r.lags.map((v) => (v == null ? null : Number(v)))]));
  });
}

/**
 * For each trade with no permit on the job yet: how likely one is to follow
 * and when, from the builder's own past jobs when it has enough, else from
 * the market's jobs of the same class, else the whole market.
 */
async function tradeOutlook({ source, gcId, cls, bpIssuedOn, trades }) {
  if (!bpIssuedOn || !trades.length) return {};
  const since = Math.floor((Date.now() - new Date(`${String(bpIssuedOn).slice(0, 10)}T00:00:00Z`)) / 86400000);
  const [own, sameClass, market] = await Promise.all([
    gcId ? tradeLags(source, { gcId }) : {},
    cls ? tradeLags(source, { cls }) : {},
    tradeLags(source),
  ]);
  const out = {};
  for (const t of trades) {
    const tries = [
      ['builder', own[t] || [], F.MIN_TRADE_COMPARABLES],
      ['class', sameClass[t] || [], F.MIN_MARKET_TRADE],
      ['market', market[t] || [], F.MIN_MARKET_TRADE],
    ];
    const [basis, lags, min] = tries.find(([, l, m]) => l.length >= m) || tries[2];
    const r = F.tradeTiming(lags, since, { min });
    out[t] = {
      ...r, lowOn: addDays(r.lowDays), midOn: addDays(r.midDays), highOn: addDays(r.highDays),
      basis: { basis, cls: basis === 'class' ? cls : null, horizonDays: F.TRADE_HORIZON_DAYS },
    };
  }
  return out;
}

/** The census class on a building permit's raw record, where the source has one. */
async function permitClass(source, permitId) {
  if (!CLASS_FIELD[source]) return null;
  const { rows: [r] } = await query(`
    SELECT ${classSql(source)} AS cls FROM permit_parties pp WHERE pp.permit_id = $1 AND pp.role = 'contractor' LIMIT 1`, [permitId]);
  return r ? r.cls : null;
}

module.exports = { CLASS_FIELD, issueDurations, pickComparables, forecastFiling, tradeLags, tradeOutlook, permitClass, classSql };
