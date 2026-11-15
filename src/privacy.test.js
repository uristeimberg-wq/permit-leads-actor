const assert = require('node:assert');
const { redactContractor, HIDDEN_PERMIT_COLUMNS, redactPermit } = require('./privacy.js');
const { RESULT_COLUMNS, buildWhere } = require('../db/queries.js');

function check(name, fn) {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const selected = RESULT_COLUMNS.split(',').map((c) => c.trim());

check('the search API never selects owner or applicant columns (rule 5)', () => {
  for (const col of HIDDEN_PERMIT_COLUMNS) assert.ok(!selected.includes(col), `${col} is selected`);
});

check('the search API still returns the business contact', () => {
  for (const col of ['contractor_name', 'contractor_phone', 'contractor_licence']) assert.ok(selected.includes(col), col);
});

check('"has contact" only counts the contractor phone the client can see', () => {
  const { sql } = buildWhere({ hasContact: 'true' });
  assert.match(sql, /contractor_phone IS NOT NULL/);
  assert.doesNotMatch(sql, /applicant/);
});

check('exports drop owner and applicant fields but keep the contractor', () => {
  const out = redactPermit({ permitNumber: 'A', owner: 'JANE DOE', applicantName: 'J DOE', applicantPhone: '3055550100', contractorName: 'Acme Builders LLC', contractorPhone: '5125550100' });
  assert.deepStrictEqual(out, { permitNumber: 'A', contractorName: 'Acme Builders LLC', contractorPhone: '5125550100' });
});

check('an individual contractor loses name and phone in API rows', () => {
  const out = redactContractor({ id: 1, contractor_name: 'John Smith', contractor_phone: '5125550999' });
  assert.deepStrictEqual(out, { id: 1, contractor_name: null, contractor_phone: null, contractor_withheld: true });
});

check('a business keeps name and phone; an owner-builder keeps the label but not the phone', () => {
  assert.strictEqual(redactContractor({ contractor_name: 'Acme Builders LLC', contractor_phone: '5125550100' }).contractor_phone, '5125550100');
  const owner = redactContractor({ contractor_name: 'OWNER', contractor_phone: '5125550101' });
  assert.deepStrictEqual([owner.contractor_name, owner.contractor_phone], ['OWNER', null]);
});

check('an owner-builder written with a business word ("OWNER BUILDER") never shows its phone', () => {
  for (const name of ['OWNER BUILDER', 'Owner/Builder', 'HOMEOWNER BUILDER']) {
    const row = redactContractor({ contractor_name: name, contractor_phone: '5125550104' });
    assert.deepStrictEqual([row.contractor_name, row.contractor_phone], [name, null], name);
    const out = redactPermit({ permitNumber: 'C', contractorName: name, contractorPhone: '5125550104' });
    assert.deepStrictEqual([out.contractorName, out.contractorPhone], [name, null], name);
  }
});

check('a phone with no contractor name is not shown', () => {
  assert.strictEqual(redactContractor({ contractor_name: null, contractor_phone: '5125550102' }).contractor_phone, null);
});

check('exports drop an individual contractor too', () => {
  const out = redactPermit({ permitNumber: 'B', contractorName: 'Jane Doe', contractorPhone: '5125550103' });
  assert.deepStrictEqual([out.contractorName, out.contractorPhone], [null, null]);
});

// Suppressions (009) and alias filtering.
{
  const { dropSuppressedPhone, publicAliases } = require('./privacy.js');
  const sup = new Set(['+15125550100']);
  assert.strictEqual(dropSuppressedPhone({ contractor_phone: '(512) 555-0100' }, sup).contractor_phone, null);
  assert.strictEqual(dropSuppressedPhone({ contractor_phone: '512-555-0200' }, sup).contractor_phone, '512-555-0200');
  assert.strictEqual(dropSuppressedPhone({ phone: '5125550100' }, sup, 'phone').phone, null);
  assert.deepStrictEqual(dropSuppressedPhone(null, sup), null);
  const row = { contractor_phone: '5125550100' };
  assert.strictEqual(dropSuppressedPhone(row, new Set()), row);
  const names = publicAliases([{ name: 'Smith Electric LLC', seen: 9 }, { name: 'John Smith', seen: 2 }, { name: null, seen: 1 }]);
  assert.deepStrictEqual(names.map((a) => a.name), ['Smith Electric LLC']);
  console.log('privacy: suppressions and aliases ok');
}
