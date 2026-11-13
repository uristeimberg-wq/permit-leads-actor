const assert = require('node:assert');
const { STAGES, DEFAULT_STAGES, stageFor, isValidStage } = require('./status.js');
const { SOURCES } = require('./sources.js');

function check(name, fn) {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

check('a finished permit is never reported as approved', () => {
  // The whole point of this module: "Finaled" used to be stored as 'issued',
  // identical to a permit approved yesterday. A finished job is not a lead.
  for (const finished of ['Final', 'Finaled', 'Completed', 'Closed']) {
    assert.strictEqual(stageFor(finished), STAGES.FINISHED, `${finished} must be finished`);
    assert.notStrictEqual(stageFor(finished), STAGES.APPROVED);
  }
});

check('an approved permit is approved', () => {
  assert.strictEqual(stageFor('Issued'), STAGES.APPROVED);
  assert.strictEqual(stageFor('Permit Issued'), STAGES.APPROVED);
});

check('awaiting-approval statuses are pending', () => {
  for (const pending of [
    'App Submitted', 'In Review', 'Prescreen', 'Lobby', 'Applicant Upload',
    'Intake Requirements Needed', 'Addl Info Needed', 'App Accepted/In Review',
    'In Review/Addl Info Needed', 'Revision Complete', 'Pending',
  ]) {
    assert.strictEqual(stageFor(pending), STAGES.PENDING, `${pending} must be pending`);
  }
});

check('"ready to issue" and "payment due" stay pending, not approved', () => {
  // Deliberate call: nothing has been issued, so the work isn't committed.
  assert.strictEqual(stageFor('Ready to Issue'), STAGES.PENDING);
  assert.strictEqual(stageFor('Ready'), STAGES.PENDING);
  assert.strictEqual(stageFor('Payment Due'), STAGES.PENDING);
});

check('dead permits are cancelled, not pending work', () => {
  for (const dead of ['Void', 'Cancelled', 'Withdrawn', 'Expired', 'Denied', 'Revoked']) {
    assert.strictEqual(stageFor(dead), STAGES.CANCELLED, `${dead} must be cancelled`);
  }
});

check('matching is case- and whitespace-insensitive', () => {
  assert.strictEqual(stageFor('  ISSUED  '), STAGES.APPROVED);
  assert.strictEqual(stageFor('FiNaLeD'), STAGES.FINISHED);
});

check('an unrecognized status becomes unknown, never a real stage', () => {
  // Guessing here would be the dangerous failure: silently filing an unknown
  // status as approved would put finished work back into results.
  for (const odd of ['Something New', '', '   ', null, undefined]) {
    assert.strictEqual(stageFor(odd), STAGES.UNKNOWN);
  }
});

check('every status mapped by a live source resolves to a real stage', () => {
  // sources.js statusMaps were built from statuses actually observed in live
  // Clackamas and Oregon runs. None of them may fall through to unknown.
  const missing = [];
  for (const source of Object.values(SOURCES)) {
    for (const raw of Object.keys(source.statusMap ?? {})) {
      if ((source.statusStages || {})[raw] == null && stageFor(raw) === STAGES.UNKNOWN) missing.push(`${source.label}: "${raw}"`);
    }
  }
  assert.deepStrictEqual(missing, [], `unmapped live statuses: ${missing.join(', ')}`);
});

check('the default view is pending + approved — work that might still happen', () => {
  assert.deepStrictEqual(DEFAULT_STAGES, [STAGES.PENDING, STAGES.APPROVED]);
  assert.ok(!DEFAULT_STAGES.includes(STAGES.FINISHED), 'finished work must be excluded by default');
  assert.ok(!DEFAULT_STAGES.includes(STAGES.CANCELLED));
});

check('isValidStage accepts real stages and rejects anything else', () => {
  assert.ok(isValidStage('pending'));
  assert.ok(isValidStage('APPROVED'));
  assert.ok(!isValidStage('bogus'));
  assert.ok(!isValidStage(''));
});

check('statuses that surfaced as unknown in live data are now mapped', () => {
  // Both appeared in a real Oregon run and were correctly reported as unknown
  // rather than guessed at. This locks in the decision made about each.
  assert.strictEqual(stageFor('Revision Request Accepted'), STAGES.PENDING);
  assert.strictEqual(stageFor('TCO Issued'), STAGES.FINISHED);
  assert.strictEqual(stageFor('Withdrawn'), STAGES.CANCELLED);
});

check('Austin\u2019s status vocabulary maps to the right stages', () => {
  // Taken from live status counts on Austin's dataset (2.37M rows).
  assert.strictEqual(stageFor('Active'), STAGES.APPROVED);   // ~28k live permits
  assert.strictEqual(stageFor('Final'), STAGES.FINISHED);    // ~2M historical
  assert.strictEqual(stageFor('Closed'), STAGES.FINISHED);
  assert.strictEqual(stageFor('Pending'), STAGES.PENDING);
  assert.strictEqual(stageFor('Inactive Pending Revision'), STAGES.PENDING);
  for (const dead of ['VOID', 'Expired', 'Withdrawn', 'Aborted', 'Cancelled - Contractor Required']) {
    assert.strictEqual(stageFor(dead), STAGES.CANCELLED, `${dead} must be cancelled`);
  }
});

check('Austin\u2019s "Active" is approved, never confused with "Final"', () => {
  // Austin has ~2M Final vs ~28k Active. Collapsing them would bury the live
  // pool under two million finished jobs.
  assert.notStrictEqual(stageFor('Active'), stageFor('Final'));
});

console.log('\nDone.');

check('Austin values from the first live sync map, and "on hold" stays unknown', () => {
  assert.strictEqual(stageFor('Pending Permit'), STAGES.PENDING);
  assert.strictEqual(stageFor('Expired - License'), STAGES.CANCELLED);
  assert.strictEqual(stageFor('On Hold'), 'unknown');
});
