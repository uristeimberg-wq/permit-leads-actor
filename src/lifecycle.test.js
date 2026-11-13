const assert = require('node:assert');
const { STAGES, lifecycleStage, validateVocabulary } = require('./lifecycle.js');
const { SOURCES } = require('./sources.js');
const { mapRows } = require('./adapters/socrata.js');

const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
};
const pr = SOURCES['austin-plan-review-tx'];

check('a mapped status gets its stage, whatever the case and spacing', () => {
  assert.strictEqual(lifecycleStage(pr, '  In   Review '), 'in_review');
  assert.strictEqual(lifecycleStage(pr, 'VOID'), 'cancelled');
  // Plan approval is not an issued permit.
  assert.strictEqual(lifecycleStage(pr, 'Approved'), 'approved');
  assert.strictEqual(lifecycleStage(SOURCES['austin-tx'], 'Active'), 'issued');
});

check('an unmapped or empty status is unknown, never guessed from similar wording', () => {
  assert.strictEqual(lifecycleStage(SOURCES['austin-tx'], 'Pending'), 'unknown');
  assert.strictEqual(lifecycleStage(pr, 'Approved with conditions'), 'unknown');
  assert.strictEqual(lifecycleStage(pr, ''), 'unknown');
  assert.strictEqual(lifecycleStage({}, 'Issued'), 'unknown');
});

check('a source with no status column maps its derived stage', () => {
  const md = SOURCES['miami-dade-fl'];
  assert.strictEqual(lifecycleStage(md, 'Issued', 'approved'), 'issued');
  assert.strictEqual(lifecycleStage(md, 'Certificate of Completion', 'finished'), 'completed');
  assert.strictEqual(lifecycleStage(md, null, undefined), 'unknown');
});

check('every vocabulary maps to known stages with normalized keys', () => {
  for (const [slug, src] of Object.entries(SOURCES)) assert.deepStrictEqual(validateVocabulary(slug, src), [], slug);
  assert.deepStrictEqual(validateVocabulary('x', { lifecycle: { statuses: { Issued: 'issued', done: 'complete' } } }),
    ['x: "Issued" -> "issued"', 'x: "done" -> "complete"']);
  assert.ok(STAGES.includes('unknown'));
});

check('plan-review rows map to applications with official dates, a URL and only real addresses', () => {
  const [a, b] = mapRows([
    { permit_number: '2026-149359 PR', status_current: 'Pending', applied_date: '2026-11-13T00:00:00.000', status_date: '2026-11-13T09:56:35.000',
      project_name: '4211 S LAMAR BLVD NB', web_link: { url: 'https://abc.austintexas.gov/x' }, sub_type: 'C-1000 Commercial Remodel' },
    { permit_number: '2026-000001 PR', status_current: 'Approved', applied_date: '2026-10-01T00:00:00.000', project_name: 'Barton Market Phase 2' },
  ], pr, { log: () => {} });
  assert.deepStrictEqual([a.filingKind, a.lifecycleStage, a.submittedOn, a.stageSince, a.permitUrl, a.address],
    ['building_application', 'submitted', '2026-11-13', '2026-11-13', 'https://abc.austintexas.gov/x', '4211 S LAMAR BLVD NB']);
  // A project title is not an address.
  assert.deepStrictEqual([b.address, b.lifecycleStage, b.stageSince], [null, 'approved', null]);
});
