// Fields that are stored but must never reach a client or an export until the
// homeowner track's compliance gate passes (CLAUDE.md rule 5, ADR-10).
//
// - owner: a property owner is usually a private individual.
// - applicant name and phone: the applicant is often the homeowner or a
//   permit runner, not the business doing the work.
//
// The contractor fields are the business to contact (B2B), but only when the
// contractor is a business. `redactContractor` applies the resolver's rule
// (src/contractors.js partyKind, ADR-12): a phone is shown only for a
// business-looking name; a person-looking or unclear name is withheld too.

const { partyKind, isOwnerBuilder } = require('./contractors.js');

const HIDDEN_PERMIT_COLUMNS = ['owner', 'applicant_name', 'applicant_phone'];
const HIDDEN_PERMIT_FIELDS = ['owner', 'applicantName', 'applicantPhone'];

/** A copy of a mapped permit without the hidden fields, for exports. */
function redactPermit(permit) {
  const out = { ...permit };
  for (const f of HIDDEN_PERMIT_FIELDS) delete out[f];
  if ((out.contractorName != null || out.contractorPhone != null) && !isShownContractor(out.contractorName)) {
    out.contractorPhone = null;
    if (out.contractorName != null && !isOwnerBuilder(out.contractorName)) out.contractorName = null;
  }
  return out;
}

/** True when a contractor name may be shown with its phone. */
function isShownContractor(name) {
  return partyKind(name) === 'business';
}

/**
 * A copy of a permit row (snake_case, as the API returns it) with the
 * contractor's phone removed unless the contractor looks like a business, and
 * the name removed when it looks like a person or is unclear. Owner-builder
 * markers ("OWNER") keep their label but lose the phone: it is the owner's.
 */
function redactContractor(row) {
  if (!row || (row.contractor_name == null && row.contractor_phone == null)) return row;
  const out = { ...row };
  if (!isShownContractor(out.contractor_name)) {
    out.contractor_phone = null;
    if (out.contractor_name != null && !isOwnerBuilder(out.contractor_name)) {
      out.contractor_name = null;
      out.contractor_withheld = true;
    }
  }
  return out;
}

module.exports = { HIDDEN_PERMIT_COLUMNS, HIDDEN_PERMIT_FIELDS, redactPermit, redactContractor, isShownContractor };
