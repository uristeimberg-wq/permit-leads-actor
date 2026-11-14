// People's details out of a raw row before it is printed or committed as a
// fixture (CLAUDE.md rule 5). No dependencies: recon scripts that run in
// Actions without npm ci require it. Tested via recon/capture_fixture.test.js.

const PERSON_FIELD = /owner|applicant|full_?name|first_?name|last_?name|contact_?name|agent|architect|engineer|designer|surveyor|other_address/i; // other_address: Austin plan review, often an owner's name and address
const PHONE_FIELD = /phone|tel|fax|mobile/i;
const EMAIL_FIELD = /e_?mail/i;

/** A copy of one raw row with people's details replaced. Pure; tested. */
function redactRow(row) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(row)) {
    if (v == null || v === '') { out[k] = v; continue; }
    if (EMAIL_FIELD.test(k)) out[k] = 'redacted@example.com';
    else if (PHONE_FIELD.test(k)) { n += 1; out[k] = `512555${String(100 + n).padStart(4, '0')}`; }
    else if (PERSON_FIELD.test(k)) out[k] = 'REDACTED';
    else out[k] = v;
  }
  return out;
}

module.exports = { redactRow, PERSON_FIELD };
