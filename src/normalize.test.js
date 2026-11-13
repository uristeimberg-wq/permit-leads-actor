const assert = require('node:assert');
const { createStatusNormalizer, normalizePermit } = require('./normalize.js');
const { mapRows } = require('./adapters/csv.js');
const { scorePermit } = require('./scoring.js');

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

// Collects log.warning calls so tests can assert on what a run would report.
function fakeLog() {
  const warnings = [];
  return { warnings, info: () => {}, warning: (m) => warnings.push(m) };
}

check('statusMap translates a portal vocabulary into applied/issued', () => {
  const { normalize } = createStatusNormalizer({
    statusMap: { 'under review': 'applied', finaled: 'issued' },
  });
  assert.strictEqual(normalize('Under Review'), 'applied');
  assert.strictEqual(normalize('Finaled'), 'issued');
});

check('already-known statuses pass through without a statusMap', () => {
  const { normalize } = createStatusNormalizer();
  assert.strictEqual(normalize('Applied'), 'applied');
  assert.strictEqual(normalize('ISSUED'), 'issued');
});

check('unmapped status is reported once with a count, not per row', () => {
  const log = fakeLog();
  const status = createStatusNormalizer({ statusMap: { issued: 'issued' }, label: 'test-src' });
  status.normalize('Expired');
  status.normalize('Expired');
  status.normalize('Withdrawn');
  status.report(log);

  assert.strictEqual(log.warnings.length, 1);
  assert.match(log.warnings[0], /"expired" x2/);
  assert.match(log.warnings[0], /"withdrawn" x1/);
  assert.match(log.warnings[0], /statusMap/);
});

check('report() stays silent when every status mapped cleanly', () => {
  const log = fakeLog();
  const status = createStatusNormalizer();
  status.normalize('applied');
  status.report(log);
  assert.strictEqual(log.warnings.length, 0);
});

check('a missing status defaults to applied (original main.js behavior)', () => {
  const { normalize } = createStatusNormalizer();
  assert.strictEqual(normalize(undefined), 'applied');
  assert.strictEqual(normalize(null), 'applied');
});

check('a present-but-empty status stays empty and earns no timing bonus', () => {
  // Guards the `??` vs `||` distinction: the original code only defaulted on
  // null/undefined, so an empty CSV cell must not silently gain +12.
  const { normalize } = createStatusNormalizer();
  const status = normalize('');
  assert.strictEqual(status, '');

  const { score } = scorePermit(
    { workDescription: 'Re-roof, tear off and replace', valuation: 12000, status },
    'roofing',
  );
  assert.strictEqual(score, 95); // 95 base, no bonus
});

check('normalizePermit coerces valuation and defaults description', () => {
  const p = normalizePermit({ status: 'applied' });
  assert.strictEqual(p.valuation, 0);
  assert.strictEqual(p.workDescription, '');
  assert.strictEqual(p.address, null);
  assert.strictEqual(p.permitNumber, null);

  assert.strictEqual(normalizePermit({ valuation: '75000' }).valuation, 75000);
  assert.strictEqual(normalizePermit({ valuation: 'n/a' }).valuation, 0);
});

check('csv mapRows maps raw rows through the source columnMap', () => {
  const source = {
    label: 'fixture',
    columnMap: {
      address: 'Address',
      workDescription: 'Description',
      valuation: 'Valuation',
      status: 'Status',
      permitUrl: 'PermitURL',
    },
  };
  const rows = [
    {
      Address: '123 SE Main St',
      Description: 'Basement to duplex conversion',
      Valuation: '43000',
      Status: 'Applied',
      PermitURL: 'https://example.test/p/1',
    },
  ];

  const [permit] = mapRows(rows, source, fakeLog());
  assert.strictEqual(permit.address, '123 SE Main St');
  assert.strictEqual(permit.valuation, 43000);
  assert.strictEqual(permit.status, 'applied');
  assert.strictEqual(permit.permitUrl, 'https://example.test/p/1');

  // End-to-end: the mapped permit scores the same as the hand-built one in
  // scoring.test.js, proving the adapter feeds scorePermit correctly.
  assert.strictEqual(scorePermit(permit, 'flooring').score, 97);
});

check('csv mapRows tolerates rows missing mapped columns', () => {
  const source = { label: 'fixture', columnMap: { address: 'Address', status: 'Status' } };
  const [permit] = mapRows([{}], source, fakeLog());
  assert.strictEqual(permit.address, null);
  assert.strictEqual(permit.workDescription, '');
  assert.strictEqual(permit.status, 'applied');
});

console.log('\nDone.');
