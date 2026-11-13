const assert = require('node:assert');
const { HIDDEN_PERMIT_COLUMNS, redactPermit } = require('./privacy.js');
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
  const out = redactPermit({ permitNumber: 'A', owner: 'JANE DOE', applicantName: 'J DOE', applicantPhone: '3055550100', contractorName: 'Acme', contractorPhone: '5125550100' });
  assert.deepStrictEqual(out, { permitNumber: 'A', contractorName: 'Acme', contractorPhone: '5125550100' });
});
