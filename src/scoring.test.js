const assert = require('node:assert');
const { scorePermit, tierFor } = require('./scoring.js');

function check(name, fn) {
  try {
    fn();
    console.log(`ok   - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

check('basement to duplex conversion scores Tier A for flooring', () => {
  const { score } = scorePermit(
    { workDescription: 'Basement to duplex conversion', valuation: 43000, status: 'applied' },
    'flooring',
  );
  assert.strictEqual(score, 97); // 85 base + 12 applied bonus
  assert.strictEqual(tierFor(score), 'A');
});

check('solar-only permit is filtered to zero regardless of trade', () => {
  const { score } = scorePermit(
    { workDescription: 'Solar panel installation, roof mount', valuation: 15000, status: 'applied' },
    'roofing',
  );
  assert.strictEqual(score, 0);
  assert.strictEqual(tierFor(score), null);
});

check('re-roof permit scores Tier A for roofing', () => {
  const { score } = scorePermit(
    { workDescription: 'Re-roof, tear off and replace', valuation: 12000, status: 'issued' },
    'roofing',
  );
  assert.strictEqual(score, 100); // 95 base + 5 issued bonus
  assert.strictEqual(tierFor(score), 'A');
});

check('mid-value remodel scores Tier C for flooring, not B', () => {
  const { score } = scorePermit(
    { workDescription: 'Interior remodel, kitchen and bath', valuation: 30000, status: 'issued' },
    'flooring',
  );
  assert.strictEqual(score, 45); // 40 base + 5 issued bonus
  assert.strictEqual(tierFor(score), 'C');
});

check('unrelated permit (deck) scores zero and drops', () => {
  const { score } = scorePermit(
    { workDescription: 'New deck construction, 200 sq ft', valuation: 8000, status: 'applied' },
    'flooring',
  );
  assert.strictEqual(score, 0);
});

check('unknown trade throws a clear error', () => {
  assert.throws(() => scorePermit({ workDescription: 'test' }, 'landscaping'));
});


check('"Residential" is not mistaken for an exterior re-side (regression)', () => {
  // /re[\s-]?side/ used to match "Reside" inside "Residential", scoring every
  // residential permit 87 as a Tier A painting lead.
  const { score } = scorePermit(
    { workDescription: 'Building - Residential New', valuation: 0, status: 'applied' },
    'painting',
  );
  assert.strictEqual(score, 0);
});

check('genuine re-side wording still scores for painting', () => {
  for (const desc of ['Exterior re-side of house', 'Re-siding, full exterior']) {
    const { score } = scorePermit({ workDescription: desc, valuation: 0, status: 'applied' }, 'painting');
    assert.strictEqual(score, 87, `expected 87 for "${desc}"`); // 75 + 12 applied
  }
});

console.log('\nDone.');
