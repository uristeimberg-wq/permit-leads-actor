// Offline tests for src/forecast.js: node src/forecast.test.js
const assert = require('node:assert');
const { quantile, issueForecast, tradeTiming, momentum } = require('./forecast.js');

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
};
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('nearest-rank quantiles', () => {
  const xs = range(1, 10);
  assert.deepStrictEqual([quantile(xs, 0), quantile(xs, 0.2), quantile(xs, 0.5), quantile(xs, 0.8), quantile(xs, 1)], [1, 2, 5, 8, 10]);
  assert.strictEqual(quantile([], 0.5), null);
});

test('issue forecast: a new filing gets the middle 60% of all comparables', () => {
  const f = issueForecast(range(1, 100), 0);
  assert.strictEqual(f.status, 'ok');
  assert.deepStrictEqual([f.lowDays, f.midDays, f.highDays, f.n, f.nAtAge], [20, 50, 80, 100, 100]);
});

test('issue forecast is conditional on age: only cases still open that late count', () => {
  const f = issueForecast(range(1, 100), 50);
  // Open at day 50: 51..100 (50 cases). 20th pct 60, median 75, 80th 90; minus 50 days elapsed.
  assert.deepStrictEqual([f.status, f.nAtAge, f.lowDays, f.midDays, f.highDays], ['ok', 50, 10, 25, 40]);
});

test('issue forecast: too few comparables, and a filing older than nearly all of them', () => {
  assert.strictEqual(issueForecast(range(1, 19), 0).status, 'thin');
  const late = issueForecast(range(1, 100), 90);
  assert.strictEqual(late.status, 'overdue');
  assert.strictEqual(late.pastShare, 0.9);
});

test('issue forecast ignores negative and missing durations', () => {
  const f = issueForecast([...range(1, 20), -5, NaN, null], 0);
  assert.strictEqual(f.n, 20);
});

test('trade timing: likelihood and window for a job that has just started', () => {
  // 10 jobs: 8 got the trade 10..80 days after the BP, 2 never did.
  const lags = [10, 20, 30, 40, 50, 60, 70, 80, null, null];
  const t = tradeTiming(lags, 0);
  assert.strictEqual(t.status, 'ok');
  assert.strictEqual(t.likelihood, 0.8);
  assert.strictEqual(t.uptake, 0.8);
  assert.deepStrictEqual([t.lowDays, t.midDays, t.highDays], [20, 40, 70]);
});

test('trade timing: the longer a job waits, the less likely and the later', () => {
  const lags = [...range(1, 40), null, null, null, null, null, null, null, null, null, null];
  const early = tradeTiming(lags, 0);
  const later = tradeTiming(lags, 30);
  assert.ok(later.likelihood < early.likelihood);
  assert.strictEqual(later.waiting, 20); // 10 still to come, 10 never
  assert.strictEqual(later.likelihood, 0.5);
});

test('trade timing: a lag past the horizon counts as none; thin and late are flagged', () => {
  const t = tradeTiming([10, 20, 30, 40, 50, 60, 70, 500], 0);
  assert.strictEqual(t.withTrade, 7);
  assert.strictEqual(tradeTiming([10, 20], 0).status, 'thin');
  assert.strictEqual(tradeTiming(range(1, 20), 200).status, 'late');
  assert.strictEqual(tradeTiming(range(1, 20), 15).status, 'late', 'only 5 comparables still waiting');
});

test('trade timing: nobody left to come gives likelihood 0, no window', () => {
  const t = tradeTiming([5, 5, 5, 5, ...Array(10).fill(null)], 10);
  assert.deepStrictEqual([t.status, t.likelihood, t.midDays], ['ok', 0, null]);
});

test('momentum: rising, new, slowing, steady, and withheld without history', () => {
  assert.strictEqual(momentum(9, 3).trend, 'rising');
  assert.strictEqual(momentum(5, 0, { firstSeenRecently: true }).trend, 'new');
  assert.strictEqual(momentum(5, 0).trend, 'rising', 'back after a quiet spell');
  assert.strictEqual(momentum(2, 0).trend, 'steady', 'two jobs is not a trend');
  assert.strictEqual(momentum(2, 8).trend, 'slowing');
  assert.strictEqual(momentum(6, 5).trend, 'steady');
  const m = momentum(9, 0, { historyCovers: false });
  assert.deepStrictEqual([m.trend, m.prior, m.change], ['unknown', null, null]);
});

if (failures) process.exitCode = 1;
