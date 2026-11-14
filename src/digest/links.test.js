// Unit: signed digest links (src/digest/links.js). Offline.
const assert = require('node:assert');
const L = require('./links.js');

const secret = 'x'.repeat(40);
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
};

check('a job token round-trips and names one permit and one subscription', () => {
  const now = Date.UTC(2026, 10, 14);
  const t = L.sign(secret, { kind: 'j', subscriptionId: 7, targetId: 12345, expiresAt: now + 86400000 });
  assert.match(t, /^v1\.j\.7\.12345\.\d+\.[\w-]{22}$/);
  assert.deepStrictEqual(L.verify(secret, t, { now }), { kind: 'j', subscriptionId: 7, targetId: 12345, expiresAt: now + 86400000 });
});

check('expired, tampered, wrong-key and junk tokens are refused', () => {
  const now = Date.UTC(2026, 10, 14);
  const t = L.sign(secret, { kind: 'j', subscriptionId: 7, targetId: 1, expiresAt: now + 1000 });
  assert.strictEqual(L.verify(secret, t, { now: now + 2000 }), null, 'expired');
  assert.strictEqual(L.verify(secret, t.replace('.j.7.1.', '.j.7.2.'), { now }), null, 'other permit');
  assert.strictEqual(L.verify(secret, t.replace('.j.7.', '.j.8.'), { now }), null, 'other subscription');
  assert.strictEqual(L.verify(secret, t.replace('v1.j.', 'v1.u.'), { now }), null, 'other kind');
  assert.strictEqual(L.verify('y'.repeat(40), t, { now }), null, 'other key');
  for (const junk of [null, '', 'abc', `${t}x`, t.slice(0, -1), '../etc/passwd']) assert.strictEqual(L.verify(secret, junk, { now }), null, String(junk));
});

check('unsubscribe tokens never expire', () => {
  const t = L.sign(secret, { kind: 'u', subscriptionId: 3 });
  assert.deepStrictEqual(L.verify(secret, t, { now: Date.UTC(2040, 0, 1) }), { kind: 'u', subscriptionId: 3, targetId: 0, expiresAt: null });
});

check('linkMaker builds absolute URLs; job links last 60 days', () => {
  const now = Date.UTC(2026, 10, 14);
  const m = L.linkMaker({ secret, baseUrl: 'https://app.example.com/', subscriptionId: 9, now });
  const job = m.job(55);
  assert.match(job, /^https:\/\/app\.example\.com\/l\/v1\.j\.9\.55\./);
  const t = L.verify(secret, job.split('/l/')[1], { now });
  assert.strictEqual(t.expiresAt, now + L.JOB_LINK_DAYS * 86400000);
  assert.match(m.unsubscribe(), /^https:\/\/app\.example\.com\/u\/v1\.u\.9\.0\.0\./);
});

check('a real send needs LINK_SECRET; a dry run falls back to a labelled dev key', () => {
  assert.throws(() => L.linkSecret({}, { required: true }), /LINK_SECRET/);
  assert.throws(() => L.linkSecret({ LINK_SECRET: 'short' }, { required: true }), (e) => e.errorClass === 'config');
  assert.deepStrictEqual(L.linkSecret({}), { secret: L.DEV_SECRET, dev: true });
  assert.deepStrictEqual(L.linkSecret({ LINK_SECRET: secret }, { required: true }), { secret, dev: false });
});

check('bad inputs do not sign', () => {
  assert.throws(() => L.sign(secret, { kind: 'x', subscriptionId: 1 }));
  assert.throws(() => L.sign(secret, { kind: 'j', subscriptionId: -1 }));
  assert.throws(() => L.sign(secret, { kind: 'j', subscriptionId: 'a' }));
});

if (failures) { console.error(`\n${failures} digest link test(s) failed`); process.exit(1); }
console.log('\nall digest link tests passed');
