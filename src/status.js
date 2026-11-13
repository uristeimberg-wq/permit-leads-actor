// Permit lifecycle stage.
//
// The scoring engine only cares whether a permit is 'applied' or 'issued', so
// that's all we used to keep — which meant a FINISHED job (`Finaled`,
// `Completed`) was stored identically to one approved yesterday. For finding
// work that hasn't happened yet, those are opposites: one is a lead, the other
// is over.
//
// So a permit carries three status values:
//   statusRaw   — the portal's exact wording, never guessed at
//   statusStage — the lifecycle stage below, which is what users filter on
//   status      — the old applied/issued bucket, kept so scoring is unaffected
//
// Every entry below was observed in live Clackamas or Oregon data, except the
// `cancelled` group, which is mapped pre-emptively so those values don't land
// in `unknown` the first time a portal emits one.

const STAGES = {
  PENDING: 'pending',     // submitted, under review — not approved yet
  APPROVED: 'approved',   // permit issued, work can proceed
  FINISHED: 'finished',   // finalled/completed — the work is done
  CANCELLED: 'cancelled', // void, withdrawn, expired, denied
  UNKNOWN: 'unknown',     // unrecognized; surfaced rather than assumed
};

const STAGE_BY_STATUS = {
  // --- pending: nothing is issued yet -------------------------------------
  'app submitted': STAGES.PENDING,
  'app submitted/addl info needed': STAGES.PENDING,
  'app accepted/in review': STAGES.PENDING,
  'application accepted': STAGES.PENDING,
  'applicant upload': STAGES.PENDING,
  'addl info needed': STAGES.PENDING,
  'in review': STAGES.PENDING,
  'in review/addl info needed': STAGES.PENDING,
  'intake requirements needed': STAGES.PENDING,
  'plan review': STAGES.PENDING,
  'under review': STAGES.PENDING,
  'revision complete': STAGES.PENDING,
  // Observed live in Oregon: a revision is in progress, so the permit is back
  // in review rather than settled.
  'revision request accepted': STAGES.PENDING,
  // Austin: the permit is paused awaiting a revision, so it is back in review.
  'inactive pending revision': STAGES.PENDING,
  // Austin, seen in the first live sync (2026-11-13): not yet issued.
  'pending permit': STAGES.PENDING,
  submitted: STAGES.PENDING,
  applied: STAGES.PENDING,
  prescreen: STAGES.PENDING,
  pending: STAGES.PENDING,
  lobby: STAGES.PENDING,
  // Both of these sit right at the line, and both stay pending on purpose:
  // the permit has not been issued, so the work isn't committed yet.
  'ready to issue': STAGES.PENDING,
  ready: STAGES.PENDING,
  'payment due': STAGES.PENDING,

  // --- approved: issued, work can start ------------------------------------
  issued: STAGES.APPROVED,
  'permit issued': STAGES.APPROVED,
  // Austin's wording for a live, issued permit — its working pool (~28k) as
  // against ~2M historical 'Final' records.
  active: STAGES.APPROVED,

  // --- finished: the job is over -------------------------------------------
  final: STAGES.FINISHED,
  finaled: STAGES.FINISHED,
  completed: STAGES.FINISHED,
  complete: STAGES.FINISHED,
  closed: STAGES.FINISHED,
  'certificate of occupancy': STAGES.FINISHED,
  // A Temporary Certificate of Occupancy means the building is occupiable —
  // construction is substantially complete. Judgment call: treated as finished,
  // since what's left is punch-list rather than the job itself.
  'tco issued': STAGES.FINISHED,
  'temporary certificate of occupancy': STAGES.FINISHED,

  // --- cancelled: went nowhere ---------------------------------------------
  void: STAGES.CANCELLED,
  voided: STAGES.CANCELLED,
  cancelled: STAGES.CANCELLED,
  canceled: STAGES.CANCELLED,
  withdrawn: STAGES.CANCELLED,
  expired: STAGES.CANCELLED,
  denied: STAGES.CANCELLED,
  revoked: STAGES.CANCELLED,
  rejected: STAGES.CANCELLED,
  // Austin's vocabulary, taken from the live status counts on its dataset.
  aborted: STAGES.CANCELLED,
  'cancelled - contractor required': STAGES.CANCELLED,
  'void - duplicate': STAGES.CANCELLED,
  // Austin, seen in the first live sync (2026-11-13). Expired like any other
  // expiry; the reason (the contractor's licence) doesn't change the stage.
  'expired - license': STAGES.CANCELLED,
  // 'on hold' (27 Austin rows) is deliberately NOT mapped: it can mean paused
  // in review or paused after issue, so it stays 'unknown' and is reported.
};

// Stages a user is normally looking for: work that might still happen.
// Finished and cancelled permits are excluded unless explicitly requested.
const DEFAULT_STAGES = [STAGES.PENDING, STAGES.APPROVED];

const ALL_STAGES = Object.values(STAGES);

/**
 * Maps a portal's raw status wording to a lifecycle stage.
 * Returns 'unknown' rather than guessing — an unrecognized status must never be
 * silently filed as approved, which would put finished work back in the results.
 *
 * @param {string|null|undefined} rawStatus
 * @returns {string} one of STAGES
 */
function stageFor(rawStatus) {
  if (rawStatus == null) return STAGES.UNKNOWN;
  const key = String(rawStatus).trim().toLowerCase();
  if (!key) return STAGES.UNKNOWN;
  return STAGE_BY_STATUS[key] ?? STAGES.UNKNOWN;
}

/** True for a stage string the API is allowed to filter on. */
function isValidStage(stage) {
  return ALL_STAGES.includes(String(stage).trim().toLowerCase());
}

module.exports = { STAGES, ALL_STAGES, DEFAULT_STAGES, STAGE_BY_STATUS, stageFor, isValidStage };
