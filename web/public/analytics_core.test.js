// Product analytics core (web/public/analytics_core.js): redaction, the
// visible-time timer, the batch queue, scroll marks, rage clicks, sessions.
const assert = require('node:assert');
const C = require('./analytics_core.js');

let failures = 0;
const check = (name, fn) => { try { fn(); console.log(`ok   - ${name}`); } catch (e) { failures += 1; console.error(`FAIL - ${name}`); console.error(e); } };

check('emails, phones and tokens in free text are redacted', () => {
  assert.strictEqual(C.redactText('call bob@acme.com re roof'), 'call [email] re roof');
  assert.strictEqual(C.redactText('512-555-0100 kitchen'), '[phone] kitchen');
  assert.strictEqual(C.redactText('(512) 555 0100'), '[phone]');
  assert.strictEqual(C.redactText('+1 512.555.0100 adu'), '[phone] adu');
  assert.strictEqual(C.redactText('key eyJhbGciOi.eyJzdWIiOiIx.abc_DEF-123'), 'key [token]');
  assert.strictEqual(C.redactText('a'.repeat(10) + ' ' + 'f'.repeat(40)), 'a'.repeat(10) + ' [token]');
});

check('permit numbers, ZIPs and plain searches are kept', () => {
  assert.strictEqual(C.redactText('2024-012345 BP'), '2024-012345 BP');
  assert.strictEqual(C.redactText('78704'), '78704');
  assert.strictEqual(C.redactText('  bathroom   remodel '), 'bathroom remodel');
  assert.strictEqual(C.redactText('ab '.repeat(100)).length, 200);
});

check('sensitive keys are dropped and nested values bounded', () => {
  const out = C.sanitizeProps({
    query: 'adu', password: 'p', authToken: 't', email: 'a@b.co', phone: '5125550100', session_key: 'k',
    filters: { zip: '78704', note: 'me@x.io', deep: { deeper: { deepest: 1 } } },
    n: 3, bad: NaN, fn: () => 1, list: [1, 'a@b.co'], 'bad key': 1,
  });
  assert.deepStrictEqual(out, { query: 'adu', filters: { zip: '78704', note: '[email]', deep: {} }, n: 3, list: [1, '[email]'] });
  assert.deepStrictEqual(C.sanitizeProps(null), {});
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
  assert.strictEqual(Object.keys(C.sanitizeProps(many)).length, 30);
});

check('active timer counts visible time only', () => {
  let t = 1000;
  const timer = C.activeTimer({ now: () => t });
  t += 4000;                 // 4 s visible
  timer.pause(); t += 60000; // a minute in a background tab
  assert.strictEqual(timer.elapsed(), 4000);
  timer.resume(); t += 1500;
  assert.strictEqual(timer.elapsed(), 5500);
  timer.pause(); timer.pause();   // pausing twice adds nothing
  t += 10000;
  assert.strictEqual(timer.elapsed(), 5500);
});

check('a timer started hidden counts nothing until shown', () => {
  let t = 0;
  const timer = C.activeTimer({ now: () => t, visible: false });
  t += 9000;
  assert.strictEqual(timer.elapsed(), 0);
  timer.resume(); t += 2000;
  assert.strictEqual(timer.elapsed(), 2000);
});

check('queue says full at 10, takes batches, and a failed batch goes back once', () => {
  const q = C.eventQueue({ maxBatch: 10, maxQueue: 25 });
  const ev = (i) => ({ event_id: `e${i}` });
  for (let i = 0; i < 9; i += 1) assert.strictEqual(q.push(ev(i)), false);
  assert.strictEqual(q.push(ev(9)), true);
  const batch = q.take();
  assert.strictEqual(batch.length, 10);
  assert.strictEqual(q.size, 0);
  q.push(ev(10));
  q.giveBack(batch);
  q.giveBack(batch);   // a second retry does not double it
  assert.strictEqual(q.size, 11);
  assert.strictEqual(q.take(1)[0].event_id, 'e0');
  for (let i = 0; i < 40; i += 1) q.push(ev(100 + i));
  assert.strictEqual(q.size, 25);   // bounded: the oldest go
});

check('scroll marks fire once each, in order', () => {
  const sent = new Set();
  assert.deepStrictEqual(C.scrollMarks(30, sent), [25]);
  assert.deepStrictEqual(C.scrollMarks(80, sent), [50, 75]);
  assert.deepStrictEqual(C.scrollMarks(60, sent), []);
  assert.deepStrictEqual(C.scrollMarks(100, sent), [100]);
  assert.strictEqual(C.scrollPercent({ scrollTop: 0, clientHeight: 500, scrollHeight: 1000 }), 50);
  assert.strictEqual(C.scrollPercent({ scrollTop: 0, clientHeight: 800, scrollHeight: 500 }), 100);
});

check('rage click: 3 quick clicks in one spot on a dead element, once per burst', () => {
  let t = 0;
  const r = C.rageDetector({ now: () => t });
  assert.strictEqual(r.click(10, 10, false), false); t += 100;
  assert.strictEqual(r.click(12, 11, false), false); t += 100;
  assert.strictEqual(r.click(11, 12, false), true); t += 100;
  assert.strictEqual(r.click(11, 12, false), false);   // same burst
  t += 5000;
  assert.strictEqual(r.click(11, 12, false), false);   // new burst starts
  const s = C.rageDetector({ now: () => t });
  s.click(0, 0, true); s.click(0, 0, true);
  assert.strictEqual(s.click(0, 0, true), false);      // a button is allowed to be clicked fast
  const far = C.rageDetector({ now: () => t });
  far.click(0, 0, false); far.click(200, 0, false);
  assert.strictEqual(far.click(400, 0, false), false); // different spots
});

check('sessions roll over after 30 idle minutes', () => {
  const id = '6f1c2b8e-3f4a-4c5d-9e6f-7a8b9c0d1e2f';
  assert.deepStrictEqual(C.sessionFor({ id, last: 0 }, 29 * 60000), { id, last: 29 * 60000, isNew: false });
  const next = C.sessionFor({ id, last: 0 }, 31 * 60000, () => 'new');
  assert.strictEqual(next.id, 'new'); assert.strictEqual(next.isNew, true);
  assert.strictEqual(C.sessionFor({ id: 'junk', last: 0 }, 1, () => 'n2').id, 'n2');
  assert.ok(C.UUID.test(C.uuid()));
});

check('taxonomy: snake_case names, known categories, high-intent events defined', () => {
  const cats = new Set(['navigation', 'search', 'record_engagement', 'export_or_action', 'auth', 'ui_interaction', 'error']);
  for (const [name, cat] of Object.entries(C.EVENTS)) { assert.match(name, /^[a-z][a-z0-9_]{1,47}$/); assert.ok(cats.has(cat), cat); }
  for (const e of C.HIGH_INTENT) assert.ok(C.EVENTS[e], e);
});

if (failures) { console.error(`${failures} failed`); process.exit(1); }
