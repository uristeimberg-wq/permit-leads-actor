const assert = require('node:assert');
const { toIsoDate } = require('./dates.js');

function check(name, fn) {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

check('normalizes the MM/DD/YYYY that Accela renders', () => {
  assert.strictEqual(toIsoDate('09/10/2026'), '2026-09-10');
  assert.strictEqual(toIsoDate('12/31/2025'), '2025-12-31');
});

check('accepts unpadded US dates', () => {
  assert.strictEqual(toIsoDate('9/4/2026'), '2026-09-04');
  assert.strictEqual(toIsoDate('1/1/2026'), '2026-01-01');
});

check('passes ISO dates through, dropping any time component', () => {
  assert.strictEqual(toIsoDate('2026-08-20'), '2026-08-20');
  assert.strictEqual(toIsoDate('2026-08-20T00:00:00.000Z'), '2026-08-20');
});

check('converts epoch milliseconds, as ArcGIS date fields arrive', () => {
  assert.strictEqual(toIsoDate(Date.UTC(2026, 7, 20)), '2026-08-20');
});

check('converts Date objects', () => {
  assert.strictEqual(toIsoDate(new Date(Date.UTC(2026, 0, 5))), '2026-01-05');
  assert.strictEqual(toIsoDate(new Date('nonsense')), null);
});

check('rejects impossible dates instead of rolling them forward', () => {
  // new Date(2026, 1, 30) would silently become March 2nd.
  assert.strictEqual(toIsoDate('02/30/2026'), null);
  assert.strictEqual(toIsoDate('13/01/2026'), null);
  assert.strictEqual(toIsoDate('2026-02-30'), null);
});

check('returns null for missing or unparseable values', () => {
  for (const v of [null, undefined, '', '   ', 'N/A', 'Pending', '20260910', {}, NaN]) {
    assert.strictEqual(toIsoDate(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});

console.log('\nDone.');
