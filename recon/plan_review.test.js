// Offline test for recon/plan_review.js analyze(): synthetic rows, no network.
const assert = require('node:assert');
const { analyze, base, daysBetween } = require('./plan_review');

assert.strictEqual(base('2025-104544 BP'), '2025-104544');
assert.strictEqual(daysBetween('2025-01-01T00:00:00.000', '2025-01-31'), 30);

const bp = (n, gc, applied, issued, wc = 'New') => ({ permit_number: `${n} BP`, permittype: 'BP', permit_class_mapped: 'Residential',
  work_class: wc, applieddate: applied, issue_date: issued, contractor_company_name: gc });
const tr = (n, code, sub, applied, issued) => ({ permit_number: `${n} ${code}`, permittype: code, permit_class_mapped: 'Residential',
  work_class: 'New', applieddate: applied, issue_date: issued, contractor_company_name: sub });

const rows = [
  bp('2025-1', 'Acme Homes', '2025-01-01T00:00:00.000', '2025-02-01T00:00:00.000'),
  tr('2025-1', 'EP', 'Sparky LLC', '2025-01-01T00:00:00.000', '2025-03-01'), // same day as BP application
  tr('2025-1', 'PP', 'Pipes Inc', '2025-01-15', '2025-03-01'), // during review
  bp('2025-2', 'Acme Homes', '2025-02-01', '2025-02-11', 'Remodel'),
  tr('2025-2', 'EP', 'Sparky LLC', '2025-03-01', '2025-03-05'), // after visible, repeat sub
  tr('2025-2', 'PP', 'Other Plumbing', '2025-02-12', '2025-03-05'), // after issue, before visible (issue+3), not a repeat
  bp('2025-3', 'Solo Builder', '2025-03-01', '2025-03-02', 'Addition'), // no trades
];
const r = analyze(rows, { today: '2026-01-01', months: 24 });

assert.strictEqual(r.reviewTime.residentialBps, 3);
assert.deepStrictEqual([r.reviewTime.all.p10, r.reviewTime.all.p50], [1, 10]);
assert.strictEqual(r.reviewTime.byWorkGroup.new.p50, 31);
assert.strictEqual(r.tradeApplicationTiming.primaries, 3);
const ep = r.tradeApplicationTiming.byTrade.electrical;
assert.strictEqual(ep.withAppliedDate, 2);
assert.strictEqual(ep.pctAppliedSameDayAsBp, 50);
assert.strictEqual(ep.pctAppliedDuringBpReview, 50);
assert.strictEqual(ep.pctAppliedAfterLeadVisible, 50);
const pp = r.tradeApplicationTiming.byTrade.plumbing;
assert.strictEqual(pp.pctAppliedDuringBpReview, 50);
assert.strictEqual(pp.pctAppliedBeforeLeadVisible, 100); // 2025-02-12 is before 2025-02-14
assert.strictEqual(r.stickiness.namedPairsDifferentCompany, 4);
assert.deepStrictEqual(r.stickiness.all, { pairs: 4, withEarlierJobSameTrade: 2, repeatSub: 1, pctRepeatOfEligible: 50 });
assert.strictEqual(r.stickiness.byTrade.electrical.pctRepeatOfEligible, 100);
assert.strictEqual(r.stickiness.byTrade.plumbing.pctRepeatOfEligible, 0);
console.log('plan_review.test.js: ok');
