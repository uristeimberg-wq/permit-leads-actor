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

// Electrical, plumbing and HVAC rules (approved 2026-11-14), on wording taken
// from the recorded fixtures of the four pilot markets. Status '' = no timing bonus.
const sub = (permitType, description, trade) =>
  scorePermit({ permitType, description, workDescription: `${permitType} — ${description}`, status: '' }, trade).score;

check('a trade permit is never a lead: the sub is already on the job', () => {
  assert.strictEqual(sub('Plumbing Permit', 'Replacement of an existing water heater', 'plumbing'), 0);
  assert.strictEqual(sub('DSINSP - Electrical (Residential)', 'Running wire from 60 amp breaker to EV charger', 'electrical'), 0);
  assert.strictEqual(sub('Plumbing Permit', 'New construction of 2 story SFR Condo', 'electrical'), 0);
  assert.strictEqual(sub('MECHANICAL', 'REPLACE SAME LOCATION CENTRAL AC / HEATING SYSTEM', 'hvac'), 0);
});

check('City of Miami NEW CONSTRUCTION components are not new homes', () => {
  for (const d of ['SURFACE PARKING LOT', 'DRIVEWAY APPROACH', 'TRUSSES', 'GARAGE OR ROLL-UP DOOR', 'RAILINGS - METAL', 'WINDOWS|REGULAR EXTERIOR:DOORS']) {
    for (const t of ['electrical', 'plumbing', 'hvac']) assert.strictEqual(sub('NEW CONSTRUCTION', d, t), 0, `${d} / ${t}`);
  }
  assert.strictEqual(sub('Building Permit', 'ePlan: New Construction accessory Dumpster Enclosure (270 sf.)', 'electrical'), 0);
});

check('new homes and units score 90 for every sub trade', () => {
  for (const [type, d] of [['Building', 'New SFD Watkins Glen Lot 46'], ['Building', 'Townhomes, 6 units, Lots 1-6, 3 stories'],
    ['NEW', 'NEW HOUSE'], ['REMODELING/REPAIRS', 'SINGLE FAMILY ANCILLARY DWELLING UNIT'],
    ['Building', 'New construction of a 2-story, single family residential home.']]) {
    for (const t of ['electrical', 'plumbing', 'hvac']) assert.strictEqual(sub(type, d, t), 90, `${d} / ${t}`);
  }
});

check('a permit type that is not building work scores 0, even with the parent\'s text', () => {
  assert.strictEqual(sub('DSENG - Right of Way', 'Townhomes, 6 units, Lots 1-6', 'electrical'), 0);
  assert.strictEqual(sub('Driveway / Sidewalks', 'Construct new driveway approach', 'plumbing'), 0);
});

check('additions, remodels and trade words', () => {
  assert.strictEqual(sub('Building', 'Addition in backyard; bathroom, closet, and bedroom; brick foundation', 'plumbing'), 85);
  assert.strictEqual(sub('Building', 'Addition in backyard; bathroom, closet, and bedroom; brick foundation', 'electrical'), 65);
  assert.strictEqual(sub('Building', 'Build-out of an ~80,000 sf fitness club with large pool deck', 'hvac'), 65);
  assert.strictEqual(sub('Building', 'Renovate an existing master bath to include new plumbing, electrical and venting', 'electrical'), 75);
  assert.strictEqual(sub('Building', '12x18 covered porch on rear of house with lights and receptacles', 'electrical'), 50);
  assert.strictEqual(sub('Building', '12x18 covered porch on rear of house with lights and receptacles', 'plumbing'), 0);
  assert.strictEqual(sub('RESIDENTIAL HARDENIN', 'AC CHANGEOUT', 'hvac'), 50);
});

check('site, envelope and pool work scores 0', () => {
  for (const [type, d] of [['Building', 'Like-for-like replacement of 9 windows and 2 doors'], ['EXPEDIT CHANGE OUT', 'RE-ROOF'],
    ['ADDITION - DETACHED', 'NEW SWIMMING POOL'], ['Building Permit', 'Express: Foundation repair - installing steel piers'],
    ['Building', '428sf open deck on rear of house'], ['FENCE NOMASONRY', '6\'METAL FENCE']]) {
    for (const t of ['electrical', 'plumbing', 'hvac']) assert.strictEqual(sub(type, d, t), 0, `${d} / ${t}`);
  }
});

check('City of Miami itemized trade lines score 50 and say why', () => {
  const r = scorePermit({ permitType: 'REMODELING/REPAIRS', description: 'FIXTURE HEADS|LIGHT SOCKET|ROUGH WIRING OUTLETS', status: '' }, 'electrical');
  assert.strictEqual(r.score, 50);
  assert.match(r.reasons[0], /Itemized/);
});

check('the timing bonus still applies to sub trades', () => {
  assert.strictEqual(scorePermit({ permitType: 'NEW', description: 'NEW HOUSE', status: 'issued' }, 'plumbing').score, 95);
});

console.log('\nDone.');
