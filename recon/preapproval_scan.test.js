// Offline test for the column picker in recon/preapproval_scan.js.
const assert = require('node:assert');
const { pickCols } = require('./preapproval_scan');

const ok = (name, fn) => { fn(); console.log(`ok   - ${name}`); };

ok('Austin plan review: status, applied and issued dates, participant columns', () => {
  const c = pickCols([
    { name: 'status_current', type: 'text' }, { name: 'status_date', type: 'date' },
    { name: 'applied_date', type: 'date' }, { name: 'issued_date', type: 'date' },
    { name: 'applicant_organization_name', type: 'text' }, { name: 'applicant_phone', type: 'text' },
    { name: 'owner_full_name', type: 'text' },
  ]);
  assert.strictEqual(c.status, 'status_current');
  assert.strictEqual(c.apply, 'applied_date');
  assert.strictEqual(c.issue, 'issued_date');
  assert.deepStrictEqual(c.roles, ['applicant_organization_name', 'owner_full_name']);
});

ok('an issue date is never taken as the application date', () => {
  const c = pickCols([{ name: 'issueddate', type: 'date' }, { name: 'statuscurrent', type: 'text' }]);
  assert.strictEqual(c.apply, null);
  assert.strictEqual(c.issue, 'issueddate');
  assert.strictEqual(c.status, 'statuscurrent');
});
