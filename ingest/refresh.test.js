// Offline: the re-read's safety rule (ingest/refresh.js settle).
const assert = require('node:assert');
const { settle, refreshable, MAX_MISSING_SHARE, MIN_MISSING_TO_REFUSE } = require('./refresh.js');

const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
};

check('keys come back trimmed and the rest are missing', () => {
  const asked = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10'];
  const rows = asked.slice(1).map((k) => ({ PermitNumber: ` ${k} ` }));
  const s = settle(asked, rows, 'PermitNumber');
  assert.deepStrictEqual(s.missing, ['A1']);
  assert.strictEqual(s.refuse, null);
});

check('none returned is a broken query, not a mass deletion', () => {
  const s = settle(['A1', 'A2'], [], 'PermitNumber');
  assert.match(s.refuse, /none of the 2/);
});

check(`more than ${100 * MAX_MISSING_SHARE}% missing is refused, once it is at least ${MIN_MISSING_TO_REFUSE} permits`, () => {
  const asked = Array.from({ length: 40 }, (_, i) => `A${i}`);
  const back = (n) => asked.slice(0, n).map((k) => ({ k }));
  assert.strictEqual(settle(asked, back(32), 'k').refuse, null, '8 of 40 (20%) is allowed');
  assert.match(settle(asked, back(30), 'k').refuse, /10 of 40/);
  assert.strictEqual(settle(asked.slice(0, 4), back(2), 'k').refuse, null, '2 of 4 is too few to call a broken query');
});

check('nothing asked is nothing to refuse', () => assert.strictEqual(settle([], [], 'k').refuse, null));

check('the pilot permit feeds are re-readable; planning sources are not', () => {
  for (const s of ['austin-tx', 'austin-plan-review-tx', 'miami-dade-fl', 'miami-city-fl', 'raleigh-nc']) assert.ok(refreshable(s), s);
  assert.ok(!refreshable('austin-site-plans-tx'));
  assert.ok(!refreshable('nope'));
});
