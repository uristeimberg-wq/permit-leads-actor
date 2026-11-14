const assert = require('node:assert');
const { diff } = require('./party_kind_diff.js');
const d = diff([
  { name: 'Bluebonnet Foundation Repair', stored: 'individual' },
  { name: 'Austin Smith', stored: 'individual' },
  { name: 'Acme Builders LLC', stored: 'business' },
]);
assert.deepStrictEqual([d.total, d.toBusiness.map((r) => r.name), d.fromBusiness.length], [3, ['Bluebonnet Foundation Repair'], 0]);
console.log('all party_kind_diff tests passed');
