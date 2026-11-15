const assert = require('node:assert');
const { effectiveWindows, highWaterValues } = require('./watermark.js');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { failed += 1; console.error(`FAIL - ${name}`); console.error(err); }
}

const now = new Date('2026-11-15T17:15:00Z');
const W = [{ field: 'issue_date', days: 30 }, { field: 'statusdate', days: 14 }];

check('a daily sync keeps its configured windows', () => {
  const r = effectiveWindows(W, { issue_date: new Date('2026-11-14T17:15:00Z'), statusdate: new Date('2026-11-14T17:15:00Z') }, { now });
  assert.deepStrictEqual(r.windows, W);
  assert.deepStrictEqual(r.widened, []);
});

check('after a 20-day outage the 14-day window reaches back past the last success, plus a day', () => {
  const r = effectiveWindows(W, { issue_date: new Date('2026-10-26T17:15:00Z'), statusdate: new Date('2026-10-26T17:15:00Z') }, { now });
  assert.deepStrictEqual(r.windows.map((w) => w.days), [30, 21]);
  assert.deepStrictEqual(r.widened.map((w) => [w.field, w.from, w.to]), [['statusdate', 14, 21]]);
  assert.deepStrictEqual(r.gaps, []);
});

check('a window with no watermark uses the source\'s last success; none at all keeps the window', () => {
  const fallback = new Date('2026-10-01T00:00:00Z');
  assert.deepStrictEqual(effectiveWindows(W, new Map(), { now, fallback }).windows.map((w) => w.days), [47, 47]);
  assert.deepStrictEqual(effectiveWindows(W, new Map(), { now }).windows, W);
});

check('widening is capped; the uncovered days are reported as a gap, never hidden', () => {
  const r = effectiveWindows(W, { issue_date: new Date('2026-01-01T00:00:00Z') }, { now, maxCatchupDays: 120 });
  assert.strictEqual(r.windows[0].days, 120);
  assert.strictEqual(r.gaps.length, 1);
  assert.strictEqual(r.gaps[0].field, 'issue_date');
  assert.strictEqual(r.gaps[0].uncoveredDays, 200); // 319 days + 1 overlap - 120
});

check('per-layer windows keep their layer', () => {
  const r = effectiveWindows([{ field: 'applieddate', days: 30, layer: 0 }], { applieddate: new Date('2026-09-01T00:00:00Z') }, { now });
  assert.deepStrictEqual(r.windows, [{ field: 'applieddate', days: 77, layer: 0 }]);
});

check('high-water values: newest per field from epoch ms or floating text; future dates ignored', () => {
  const rows = [
    { issue_date: '2026-11-10T00:00:00.000', statusdate: 1762000000000 },
    { issue_date: '2026-11-12T00:00:00.000', statusdate: null },
    { issue_date: '2099-01-01T00:00:00.000' },
  ];
  assert.deepStrictEqual(highWaterValues(rows, W), { issue_date: '2026-11-12T00:00:00.000Z', statusdate: new Date(1762000000000).toISOString() });
  assert.deepStrictEqual(highWaterValues([], W), {});
});

console.log(failed ? `\n${failed} failed` : '\nDone.');
process.exitCode = failed ? 1 : 0;
