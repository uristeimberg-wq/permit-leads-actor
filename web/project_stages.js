// Project rules, in one place so they can be tuned without touching code
// elsewhere: how permits link into a project, what kind of permit each one is
// (the chips on a project card), and the construction-stage label.
//
// The stage label is OUR reading of which permits exist and their status. It
// is an inference (docs/DATA_TRUST_AUDIT.md class C), so it is only shown when
// SHOW_INFERENCES=1, and the card says it is derived from the permits on file.

// ── Linking ────────────────────────────────────────────────────────────────
// Job links that are an official number (class A/B): the Austin permit-number
// base ("2026-104544 BP" and "... EP"), the Miami-Dade master permit, the City
// of Miami application. Raleigh's job link is a parcel PIN, which holds many
// jobs over the years, so it counts as an address-like link (an inference).
const OFFICIAL_JOB_SOURCES = new Set(['austin-tx', 'miami-dade-fl', 'miami-city-fl']);
// Permits at the same address (BLDG tail removed) join when filed within this
// many days of each other; work at one house years apart stays separate.
const ADDRESS_WINDOW_DAYS = 365;
// "Ref: 2025-160598 BP" inside a description: an explicit pointer to a
// building permit, written by the applicant on the record itself.
const REF_RE = /\bref\.?\s*:?\s*#?\s*(\d{4}-\d{5,6})\s*BP\b/i;

// ── Permit kinds (the chips on a project card) ───────────────────────────────
// First match wins. `trade` and `isBuilding` come from the resolver's reading
// of the official type code; the patterns cover sources it does not map.
const KINDS = [
  { code: 'BP', label: 'Building', test: (p) => p.job && p.job.isBuilding },
  { code: 'EP', label: 'Electrical', test: (p) => (p.job && p.job.trade === 'electrical') || /electric/i.test(p.permit_type || '') },
  { code: 'MP', label: 'Mechanical', test: (p) => (p.job && p.job.trade === 'mechanical') || /mechanic|hvac|a\/c\b/i.test(p.permit_type || '') },
  { code: 'PP', label: 'Plumbing', test: (p) => (p.job && p.job.trade === 'plumbing') || /plumb|\bgas\b/i.test(p.permit_type || '') },
  { code: 'DM', label: 'Demolition', test: (p) => /demoli/i.test(p.permit_type || '') },
  // Street and sidewalk use (Raleigh "DSENG - Right of Way": lane closures,
  // obstructions). A real permit, but not building work: named, not "Other".
  { code: 'ROW', label: 'Right of way', test: (p) => /right[\s-]*of[\s-]*way|\bobstruct/i.test(p.permit_type || '') },
  { code: 'BP', label: 'Building', test: (p) => /\b(building|bldg|bp|new|alter|addition|remodel)\b/i.test(p.permit_type || '') },
  { code: 'OT', label: 'Other', test: () => true },
];
const kindOf = (p) => KINDS.find((k) => k.test(p));

// ── Construction stage ───────────────────────────────────────────────────────
// Ordered: the first rule whose `when` is true names the stage. `x` offers:
//   x.permits            every permit in the project
//   x.of(code)           permits of one kind (BP, EP, MP, PP, DM, OT)
//   x.active(p)          status is pending or approved (not finished/cancelled)
//   x.approved(p)        status is approved
const TEMP_POWER = /\b(temp(orary)?\s*(power|pole|service|electric)|t-?pole|saw\s*pole|construction\s*(power|pole))\b/i;
const SITE_WORK = /\b(site\s*work|grading|demo(lition)?|clearing|excavat|foundation\s*only|utilit(y|ies)\s*(only|connection))\b/i;
const STAGE_RULES = [
  { label: 'Cancelled', when: (x) => x.permits.every((p) => p.status_stage === 'cancelled') },
  { label: 'Finished', when: (x) => (x.of('BP').length ? x.of('BP') : x.permits).every((p) => p.status_stage === 'finished') },
  { label: 'In permitting', when: (x) => x.of('BP').length > 0 && x.of('BP').every((p) => p.status_stage === 'pending') },
  { label: 'Temp power / site work',
    when: (x) => x.permits.some((p) => x.active(p) && (TEMP_POWER.test(p.work_description || '') || (kindOf(p).code !== 'BP' && SITE_WORK.test(p.work_description || ''))))
      || x.of('DM').some((p) => x.active(p)) },
  { label: 'Rough-in (MEP)', when: (x) => ['EP', 'MP', 'PP'].some((c) => x.of(c).some((p) => x.approved(p))) },
  { label: 'Permitted – not started', when: (x) => x.of('BP').some((p) => x.approved(p)) },
  { label: 'Trade work only', when: () => true },
];

function stageOf(permits) {
  const x = {
    permits,
    of: (code) => permits.filter((p) => kindOf(p).code === code),
    active: (p) => p.status_stage === 'pending' || p.status_stage === 'approved',
    approved: (p) => p.status_stage === 'approved',
  };
  return STAGE_RULES.find((r) => r.when(x)).label;
}

module.exports = { OFFICIAL_JOB_SOURCES, ADDRESS_WINDOW_DAYS, REF_RE, KINDS, kindOf, STAGE_RULES, stageOf, TEMP_POWER, SITE_WORK };
