const assert = require('node:assert');
const { redactRow } = require('./capture_fixture.js');

const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
};

check('people, phones and emails are replaced; business and permit fields kept', () => {
  const out = redactRow({
    permit_number: '2026-1 BP', contractor_company_name: 'Acme Builders LLC', contractor_full_name: 'Jane Doe',
    contractor_phone: '5129998888', applicant_full_name: 'John Roe', applicant_phone: '5127776666',
    OwnerName: 'J DOE', ContractorEmail: 'jane@acme.test', description: 'Remodel',
  });
  assert.deepStrictEqual(out, {
    permit_number: '2026-1 BP', contractor_company_name: 'Acme Builders LLC', contractor_full_name: 'REDACTED',
    contractor_phone: '5125550101', applicant_full_name: 'REDACTED', applicant_phone: '5125550102',
    OwnerName: 'REDACTED', ContractorEmail: 'redacted@example.com', description: 'Remodel',
  });
});

check('empty values stay empty, so fill rates in the fixture stay honest', () => {
  assert.deepStrictEqual(redactRow({ contractor_phone: null, OwnerName: '' }), { contractor_phone: null, OwnerName: '' });
});
