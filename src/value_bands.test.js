const assert = require('node:assert');
const { valueBand } = require('./value_bands.js');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (e) { failures += 1; console.log(`FAIL - ${name}\n${e.stack}`); }
};

check('missing, zero and junk values have no band', () => {
  for (const v of [null, undefined, '', 0, -5, 'abc']) assert.strictEqual(valueBand(v), null);
});

check('bands are half-open: the edge belongs to the band above', () => {
  assert.deepStrictEqual(valueBand(99999), { label: 'under $100k', low: 0, high: 100e3 });
  assert.deepStrictEqual(valueBand(100000), { label: '$100k-$250k', low: 100e3, high: 250e3 });
  assert.strictEqual(valueBand(412345).label, '$250k-$500k');
  assert.strictEqual(valueBand('1500000').label, '$1M-$2M');
});

check('the top band is open-ended', () => {
  assert.deepStrictEqual(valueBand(40e6), { label: '$25M+', low: 25e6, high: null });
});

check('a band never carries the exact figure', () => {
  assert.ok(!JSON.stringify(valueBand(437210)).includes('437210'));
});

if (failures) process.exit(1);
