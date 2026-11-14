// Unit tests for src/scorecard.js (offline, no DB).
const assert = require('node:assert');
const S = require('./scorecard.js');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
};

check('every metric has a unit, a label and SQL', () => {
  for (const [k, m] of Object.entries(S.METRICS)) {
    assert.ok(['share', 'days', 'count'].includes(m.unit), k);
    assert.ok(m.label && m.sql, k);
  }
});

check('a rate keeps its numerator and denominator; an empty market is skipped', () => {
  assert.deepStrictEqual(S.toSnapshot('located', { market: 'austin-tx', num: '83', den: '100' }, '2026-11-14'),
    { measured_on: '2026-11-14', market: 'austin-tx', metric: 'located', unit: 'share', value: 0.83, numerator: 83, denominator: 100 });
  assert.strictEqual(S.toSnapshot('located', { market: 'x', num: 0, den: 0 }, '2026-11-14'), null);
  assert.strictEqual(S.toSnapshot('nope', { market: 'x', num: 1, den: 1 }, '2026-11-14'), null);
});

check('a value metric stores the value alone', () => {
  const s = S.toSnapshot('history_days', { market: 'austin-tx', value: '1' }, '2026-11-14');
  assert.deepStrictEqual([s.value, s.numerator, s.unit], [1, null, 'days']);
});

check('targets: higher is better, except days missed', () => {
  assert.deepStrictEqual([S.status('located', 0.95, 0.92), S.status('located', 0.9, 0.92), S.status('sync_days_missed_30', 0, 0), S.status('sync_days_missed_30', 2, 0), S.status('x', 1, null)],
    ['met', 'below', 'met', 'below', null]);
});

check('lower-is-better metrics: latency and duplicates meet at or under the target', () => {
  assert.deepStrictEqual([S.status('discovery_days_p50', 1, 1), S.status('discovery_days_p90', 3, 2), S.status('duplicate_rate', 0.004, 0.01), S.status('enrichment_depth', 5, 6)],
    ['met', 'below', 'met', 'below']);
});

check('all ten brief metrics are on the scorecard', () => {
  for (const k of ['pre_issue_capture', 'discovery_days_p50', 'property_match', 'enrichment_depth', 'contractor_resolved',
    'phone_coverage', 'application_linked', 'duplicate_rate', 'sync_success_30', 'open_pre_issue']) assert.ok(S.METRICS[k], k);
});

if (failures) { console.error(`${failures} failed`); process.exit(1); }
