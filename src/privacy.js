// Fields that are stored but must never reach a client or an export until the
// homeowner track's compliance gate passes (CLAUDE.md rule 5, ADR-10).
//
// - owner: a property owner is usually a private individual.
// - applicant name and phone: the applicant is often the homeowner or a
//   permit runner, not the business doing the work.
//
// The contractor fields stay: they are the business to contact (B2B).

const HIDDEN_PERMIT_COLUMNS = ['owner', 'applicant_name', 'applicant_phone'];
const HIDDEN_PERMIT_FIELDS = ['owner', 'applicantName', 'applicantPhone'];

/** A copy of a mapped permit without the hidden fields, for exports. */
function redactPermit(permit) {
  const out = { ...permit };
  for (const f of HIDDEN_PERMIT_FIELDS) delete out[f];
  return out;
}

module.exports = { HIDDEN_PERMIT_COLUMNS, HIDDEN_PERMIT_FIELDS, redactPermit };
