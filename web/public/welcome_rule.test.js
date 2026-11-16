// The welcome pop-up's ask rule (web/public/welcome_rule.js).
const assert = require('node:assert');
const W = require('./welcome_rule.js');

let failures = 0;
const check = (name, fn) => { try { fn(); console.log(`ok   - ${name}`); } catch (e) { failures += 1; console.error(`FAIL - ${name}`); console.error(e); } };
const now = Date.parse('2026-11-20T12:00:00Z');
const daysAgo = (d) => new Date(now - d * 86400000).toISOString();

check('a browser that has never seen it is asked', () => {
  assert.strictEqual(W.due(null, now), 'first');
  assert.strictEqual(W.due(undefined, now), 'first');
});
check('an answer is never asked again', () => {
  assert.strictEqual(W.due({ skipped: false, roles: ['sub'], savedAt: daysAgo(400) }, now), null);
});
check('a skip waits 7 days, then asks again', () => {
  assert.strictEqual(W.REASK_DAYS, 7);
  assert.strictEqual(W.due({ skipped: true, skippedAt: daysAgo(1) }, now), null);
  assert.strictEqual(W.due({ skipped: true, skippedAt: daysAgo(6.9) }, now), null);
  assert.strictEqual(W.due({ skipped: true, skippedAt: daysAgo(7) }, now), 'again');
  assert.strictEqual(W.due({ skipped: true, skippedAt: daysAgo(30) }, now), 'again');
});
check('a skip saved before dates were kept is due', () => {
  assert.strictEqual(W.due({ skipped: true, roles: [] }, now), 'again');
  assert.strictEqual(W.due({ skipped: true, skippedAt: 'garbage' }, now), 'again');
});
check('a skip dated in the future (clock change) waits', () => {
  assert.strictEqual(W.due({ skipped: true, skippedAt: daysAgo(-3) }, now), null);
});

if (failures) { console.error(`${failures} failed`); process.exit(1); }
