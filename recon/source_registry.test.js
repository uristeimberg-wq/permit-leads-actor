// Offline test for recon/source_registry.js and the committed registry seed.
const assert = require('node:assert');
const path = require('node:path');
const { WEIGHTS, validate, score, action, rank } = require('./source_registry');

const ok = (name, fn) => { fn(); console.log(`ok   - ${name}`); };

const base = {
  id: 'x', name: 'X', jurisdiction: 'Austin, TX', category: 'planning_case', url: 'https://example.test',
  earliest_stage: 'site_plan', access: 'open_api', terms: 'Public Domain', legal_gate: 'open',
  cadence: 'daily', status: 'candidate', verified: 'live', verified_on: '2026-11-14', basis: 'measured',
  scores: { early: 5, unique: 5, action: 5, contact: 5, fresh: 5, coverage: 5, reliability: 5, legal: 5, cost: 5 },
};
const withScores = (o, scores) => ({ ...base, ...o, scores: { ...base.scores, ...scores } });

ok('weights sum to 100', () => {
  assert.strictEqual(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

ok('all 5s score 100, all 1s score 0; legal is not a weight', () => {
  assert.strictEqual(score(base), 100);
  const ones = Object.fromEntries(Object.keys(base.scores).map((k) => [k, 1]));
  assert.strictEqual(score({ ...base, scores: { ...ones, legal: 5 } }), 0);
  assert.strictEqual(score(withScores({}, { legal: 1 })), 100);
});

ok('a blocked source is skipped whatever it scores', () => {
  assert.strictEqual(action(withScores({ legal_gate: 'blocked' }, {})), 'skip');
});

ok('a source needing counsel is never recommended for the pilot', () => {
  assert.strictEqual(action(withScores({ legal_gate: 'counsel' }, {})), 'counsel');
});

ok('estimated scores mean verify first, not build', () => {
  assert.strictEqual(action(withScores({ basis: 'estimated' }, {})), 'verify');
  assert.strictEqual(action(withScores({ status: 'probe' }, {})), 'verify');
  assert.strictEqual(action(base), 'pilot');
});

ok('entity registries are references; middling measured sources wait in the backlog', () => {
  assert.strictEqual(action(withScores({ category: 'entity_reference' }, {})), 'reference');
  const mid = withScores({}, { early: 3, unique: 3, action: 3, contact: 3, fresh: 3, coverage: 3, reliability: 3, cost: 3 });
  assert.strictEqual(score(mid), 50);
  assert.strictEqual(action(mid), 'backlog');
});

ok('low scores are skipped; on-hold stays deferred', () => {
  const low = withScores({}, { early: 1, unique: 1, action: 1, contact: 1, fresh: 2, coverage: 2 });
  assert.strictEqual(action(low), 'skip');
  assert.strictEqual(action(withScores({ status: 'on_hold' }, {})), 'deferred');
});

ok('validation catches bad scores, stages, dates and duplicates', () => {
  const errs = validate({ sources: [
    withScores({ id: 'a', earliest_stage: 'soon' }, { early: 6 }),
    withScores({ id: 'a', verified_on: 'yesterday' }, {}),
  ] });
  assert.ok(errs.some((e) => e.includes('unknown stage')));
  assert.ok(errs.some((e) => e.includes('score early')));
  assert.ok(errs.some((e) => e.includes('duplicate id')));
  assert.ok(errs.some((e) => e.includes('verified_on')));
});

ok('the committed seed validates and ranks', () => {
  const reg = require(path.join(__dirname, '..', 'docs', 'research', 'source_registry.json'));
  assert.deepStrictEqual(validate(reg), []);
  const rows = rank(reg);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.strictEqual(byId['austin-legistar-pdfs-tx'].action, 'skip');      // robots Disallow: /
  assert.strictEqual(byId['philadelphia-permits'].action, 'skip');         // no commercial use
  assert.strictEqual(byId['travis-clerk-records'].action, 'counsel');
  assert.strictEqual(byId['miami-dade-clerk-noc'].action, 'counsel');
  assert.strictEqual(byId['austin-site-plan-tx'].action, 'pilot');
  assert.strictEqual(byId['austin-row-contractors-tx'].action, 'reference');
  assert.strictEqual(byId['austin-plan-review-tx'].action, 'live');
  assert.strictEqual(rows[0].action, 'pilot');
});
