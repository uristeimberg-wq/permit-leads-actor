// The status labels never contradict the source's status (stages.js).
// Offline: reads the per-source tables in src/sources.js, no database.
const assert = require('assert');
const Stages = require('./stages.js');
const { SOURCES } = require('../../src/sources.js');
const { stageFor, ALL_STAGES } = require('../../src/status.js');
const { STAGES: LIFECYCLE_STAGES, statusKey } = require('../../src/lifecycle.js');

// Same derivation as src/adapters/socrata.js and arcgis.js for status_stage.
const groupFor = (source, raw) => (source.statusStages && source.statusStages[statusKey(raw)]) || stageFor(raw);

// 1. Every stage the code can produce has a label.
for (const s of ALL_STAGES) assert.ok(Stages.GROUP_LABEL[s], `no label for group ${s}`);
for (const s of LIFECYCLE_STAGES) assert.ok(Stages.LIFECYCLE_LABEL[s], `no label for lifecycle stage ${s}`);
for (const s of LIFECYCLE_STAGES.filter((x) => x !== 'unknown')) assert.ok(Stages.GROUP_OF_LIFECYCLE[s], `no group for ${s}`);

// 2. For every permit source, the two tables agree: a status filed as
//    lifecycle X sits in X's filter group (or is unmapped there, and then
//    shows "Status not mapped", which claims nothing).
const contradictions = [];
let checked = 0;
for (const [slug, source] of Object.entries(SOURCES)) {
  if (source.planning || !source.lifecycle || !source.lifecycle.statuses) continue;
  for (const [raw, lc] of Object.entries(source.lifecycle.statuses)) {
    const group = groupFor(source, raw);
    checked++;
    if (group !== 'unknown' && Stages.GROUP_OF_LIFECYCLE[lc] !== group) contradictions.push(`${slug} "${raw}": lifecycle ${lc}, group ${group}`);
  }
}
assert.ok(checked > 30, `checked only ${checked} statuses`);
assert.deepStrictEqual(contradictions, []);

// 3. The record from the owner's screenshot: Austin plan review, "Approved and Released".
const pr = SOURCES['austin-plan-review-tx'];
const rec = { status_raw: 'Approved and Released', status_stage: groupFor(pr, 'Approved and Released'), lifecycle_stage: pr.lifecycle.statuses['approved and released'] };
assert.deepStrictEqual(Stages.badge(rec), { group: 'pending', label: 'Approved, not issued' });

// 4. No label claims "waiting for approval" for anything: the pending group
//    holds approved-but-not-issued plans.
for (const label of [...Object.values(Stages.GROUP_LABEL), ...Object.values(Stages.LIFECYCLE_LABEL)]) {
  assert.ok(!/waiting/i.test(label), `label "${label}" claims waiting`);
}

// 5. Badge fallbacks.
assert.deepStrictEqual(Stages.badge({ status_stage: 'pending', lifecycle_stage: 'unknown' }), { group: 'pending', label: 'Not issued yet' });
assert.deepStrictEqual(Stages.badge({ status_stage: 'approved', lifecycle_stage: 'issued' }), { group: 'approved', label: 'Issued' });
assert.deepStrictEqual(Stages.badge({ status_stage: 'bogus' }), { group: 'unknown', label: 'Status not mapped' });
// A disagreement (should never happen, see 2) shows the group, not the finer stage.
assert.deepStrictEqual(Stages.badge({ status_stage: 'finished', lifecycle_stage: 'in_review' }), { group: 'finished', label: 'Finished' });
// A status that starts with "approved" never gets a not-yet-approved label,
// and one that starts with "final" or "complete" is shown as done.
// ("Prerequisite review approved" is one step inside a review still running.)
for (const [slug, source] of Object.entries(SOURCES)) {
  if (source.planning || !source.lifecycle || !source.lifecycle.statuses) continue;
  for (const [raw, lc] of Object.entries(source.lifecycle.statuses)) {
    const { label } = Stages.badge({ status_stage: groupFor(source, raw), lifecycle_stage: lc });
    if (/^approved/.test(raw)) assert.ok(/approved|issued|inspections|completed/i.test(label), `${slug} "${raw}" -> "${label}"`);
    if (/^(final|complete)/.test(raw)) assert.ok(/completed|finished/i.test(label), `${slug} "${raw}" -> "${label}"`);
  }
}

console.log(`stages.test.js: ok (${checked} source statuses checked)`);
