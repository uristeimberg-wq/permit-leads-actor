// The Contractors tab (web/contractors.js): merging duplicates, sorting, and
// which licence / registration records are shown. Offline, on hand-made rows.
const assert = require('node:assert');
const { merge, listContractors, cleanName } = require('./contractors.js');

const row = (id, o = {}) => ({ id, display_name: `Co ${id}`, normalized_name: `co ${id}`, business_state: 'TX', primary_trade: null,
  permits: 1, active: 1, active_value: null, latest: '2026-10-01', licences: null, ...o });

// Same normalized name (case, LLC, punctuation) -> one row; names kept as aliases.
const m = merge([
  row(1, { display_name: 'Acme Builders, LLC', normalized_name: 'acme builders', permits: 5, active: 3, active_value: '100000' }),
  row(2, { display_name: 'ACME BUILDERS', normalized_name: 'acme builders', business_state: null, permits: 2, active: 2, active_value: '50000', latest: '2026-11-01' }),
  row(3, { display_name: 'Volt Electric', normalized_name: 'volt electric', licences: ['TX 12345'] }),
  row(4, { display_name: 'Volt Elec. Co', normalized_name: 'volt elec', licences: ['TX 12345'] }),   // same licence number
  row(5, { display_name: 'Other Co', normalized_name: 'other co' }),
]);
assert.strictEqual(m.length, 3);
const acme = m.find((r) => r.name === 'Acme Builders, LLC');
assert.deepStrictEqual(acme.ids.sort(), ['1', '2']);
assert.deepStrictEqual(acme.aliases, ['ACME BUILDERS']);
assert.deepStrictEqual([acme.permits, acme.active, acme.activeValue, acme.latest], [7, 5, 150000, '2026-11-01']);
assert.deepStrictEqual(m.find((r) => r.ids.includes('3')).ids.sort(), ['3', '4'], 'merged by a shared licence number');

// Display names drop a portal's branch marker.
assert.strictEqual(cleanName('Joseph Design Build**MAIN***'), 'Joseph Design Build');
assert.strictEqual(cleanName('OHT Construction LLC ***MAIN***'), 'OHT Construction LLC');

(async () => {
  const rows = [row(10, { active: 1, active_value: '900000' }), row(11, { active: 9 }), row(12, { active: 4, active_value: '20000' })];
  const phonesById = async (ids) => new Map(ids.map((id) => [id, { phone: id === '11' ? { value: '+15125550100', verification: 'corroborated', seenOnPermits: 4 } : null }]));
  const recordsFor = async () => ({
    registry: [
      { contractor_id: '11', provider: 'tx-tdlr', match_rule: 'licence', licence_number: 'L1', licence_type: 'Electrical Contractor' },
      { contractor_id: '11', provider: 'tx-tdlr', match_rule: 'phone', licence_number: 'L2', licence_type: 'A/C Contractor' },
    ],
    registrations: [{ contractor_id: '11', provider: 'tx-comptroller', match_rule: 'name_state', legal_name: 'X LLC', sos_status: 'Active' }],
  });

  // Sorted by active permits (default) or by active value.
  const byActive = await listContractors({ rows, phonesById, recordsFor });
  assert.deepStrictEqual(byActive.results.map((r) => r.ids[0]), ['11', '12', '10']);
  const byValue = await listContractors({ rows, phonesById, recordsFor }, { sort: 'value' });
  assert.deepStrictEqual(byValue.results.map((r) => r.ids[0]), ['10', '12', '11']);

  // Without inferences: only a licence matched by its number; no registrations.
  const top = byActive.results[0];
  assert.strictEqual(top.phone.value, '+15125550100');
  assert.deepStrictEqual(top.registry.map((r) => r.number), ['L1']);
  assert.strictEqual(top.registry[0].official, true);
  assert.deepStrictEqual(top.registrations, []);
  // With inferences: name/phone matches too, labelled with how they matched.
  const on = (await listContractors({ rows, phonesById, recordsFor }, { inferences: true })).results[0];
  assert.deepStrictEqual(on.registry.map((r) => [r.number, r.matchedBy]), [['L1', 'licence number on the permit'], ['L2', 'same phone number']]);
  assert.strictEqual(on.registrations[0].status, 'Active');

  console.log('contractors.test.js: all passed');
})();
