/* One vocabulary for every status label the screens show.
 *
 * A record carries the source's own wording (status_raw) and two stages we
 * derive from it with reviewed, per-source tables:
 *   status_stage    src/status.js: the coarse group the Stage filter uses
 *   lifecycle_stage src/lifecycle.js: the finer stage
 *
 * The coarse 'pending' group means "no permit issued yet". It holds plans
 * that are still in review AND plans the city has approved but not issued a
 * permit for (Austin plan review "Approved and Released", Raleigh "Ready for
 * issuance"). It used to be labelled "Waiting for approval", which was false
 * for the second half: the badge said "waiting for approval" beside a source
 * status of "Approved and Released". Every label here says only what the
 * group really holds, and the badge shows the finer stage when the source's
 * wording maps to one.
 *
 * Loaded by index.html and the job page before their own scripts; also
 * required by stages.test.js in Node.
 */
(function (root) {
  // The Stage filter's groups (src/status.js STAGES), in filter order.
  const GROUPS = [
    ['pending',   'Not issued yet'],
    ['approved',  'Issued'],
    ['finished',  'Finished'],
    ['cancelled', 'Cancelled or expired'],
    ['unknown',   'Status not mapped'],
  ];
  const GROUP_LABEL = Object.fromEntries(GROUPS);

  // src/lifecycle.js STAGES.
  const LIFECYCLE_LABEL = {
    pre_application: 'Pre-application', submitted: 'Submitted', in_review: 'In review',
    corrections: 'Corrections requested', approved: 'Approved, not issued', issued: 'Issued',
    inspections: 'Inspections', completed: 'Completed', expired: 'Expired', withdrawn: 'Withdrawn',
    cancelled: 'Cancelled', denied: 'Denied', unknown: 'Stage not mapped',
  };

  // Which filter group each finer stage belongs to. stages.test.js checks
  // every source's two tables against this, so a status can never be filed in
  // one group by one table and a contradicting stage by the other.
  const GROUP_OF_LIFECYCLE = {
    pre_application: 'pending', submitted: 'pending', in_review: 'pending', corrections: 'pending',
    approved: 'pending', issued: 'approved', inspections: 'approved', completed: 'finished',
    expired: 'cancelled', withdrawn: 'cancelled', cancelled: 'cancelled', denied: 'cancelled',
  };

  const groupOf = (r) => (GROUP_LABEL[r && r.status_stage] ? r.status_stage : 'unknown');

  /**
   * The badge for one record: its finer stage when the source's wording maps
   * to one and agrees with the filter group, otherwise the group. Returns
   * { group, label } — group picks the colour, label is the text.
   */
  function badge(r) {
    const group = groupOf(r);
    const lc = r && r.lifecycle_stage;
    if (lc && lc !== 'unknown' && LIFECYCLE_LABEL[lc] && GROUP_OF_LIFECYCLE[lc] === group) {
      return { group, label: LIFECYCLE_LABEL[lc] };
    }
    return { group, label: GROUP_LABEL[group] };
  }

  const api = { GROUPS, GROUP_LABEL, LIFECYCLE_LABEL, GROUP_OF_LIFECYCLE, badge };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Stages = api;
})(typeof window !== 'undefined' ? window : globalThis);
