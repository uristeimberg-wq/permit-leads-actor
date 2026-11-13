const assert = require('node:assert');
const { MIN_ROWS, mappedFields, detectDrift } = require('./drift.js');

const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
};
const MAP = { permitNumber: 'permit_number', contractorPhone: 'contractor_phone', valuation: ['a_val', 'b_val'], derived: () => 1 };
const rows = (n, row) => Array.from({ length: n }, () => ({ ...row }));

check('mappedFields flattens arrays and skips functions', () => {
  assert.deepStrictEqual(mappedFields(MAP).map((m) => m.field), ['permit_number', 'contractor_phone', 'a_val', 'b_val']);
});

check('first run stores the fields and raises nothing', () => {
  const d = detectDrift(null, rows(10, { permit_number: 'x', contractor_phone: '1' }), MAP);
  assert.deepStrictEqual(d, { fields: ['contractor_phone', 'permit_number'], added: [], missing: [], checked: false });
});

check('a new column is reported as added and kept', () => {
  const d = detectDrift(['permit_number'], rows(3, { permit_number: 'x', new_col: 1 }), MAP);
  assert.deepStrictEqual([d.added, d.fields], [['new_col'], ['new_col', 'permit_number']]);
});

check('a mapped critical field that vanishes from a large run is an error', () => {
  const d = detectDrift(['permit_number', 'contractor_phone'], rows(MIN_ROWS, { permit_number: 'x' }), MAP);
  assert.deepStrictEqual(d.missing, [{ key: 'contractorPhone', field: 'contractor_phone', severity: 'error' }]);
});

check('a non-critical mapped field that vanishes is a warning', () => {
  const d = detectDrift(['permit_number', 'a_val'], rows(MIN_ROWS, { permit_number: 'x' }), MAP);
  assert.deepStrictEqual(d.missing.map((m) => m.severity), ['warning']);
});

check('a small run never reports a missing field (sparse columns)', () => {
  const d = detectDrift(['permit_number', 'contractor_phone'], rows(MIN_ROWS - 1, { permit_number: 'x' }), MAP);
  assert.deepStrictEqual([d.missing, d.checked], [[], false]);
});

check('an unmapped column disappearing is not an alarm, and the stored list never shrinks', () => {
  const d = detectDrift(['permit_number', 'old_unmapped'], rows(MIN_ROWS, { permit_number: 'x' }), MAP);
  assert.deepStrictEqual([d.missing, d.fields], [[], ['old_unmapped', 'permit_number']]);
});
