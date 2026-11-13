const assert = require('node:assert');
const { fetchWithRetry } = require('./http.js');

const pending = [];
function check(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => console.log(`ok   - ${name}`),
    (err) => { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; },
  ));
}
const res = (status, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k] ?? null } });
const noSleep = { sleepImpl: async () => {}, baseDelayMs: 1 };

check('a dropped connection is retried, then succeeds', async () => {
  let n = 0;
  const r = await fetchWithRetry(async () => { n += 1; if (n < 3) throw new Error('fetch failed'); return res(200); }, 'u', undefined, noSleep);
  assert.strictEqual(r.status, 200); assert.strictEqual(n, 3);
});

check('5xx and 429 are retried; the last response is returned when retries run out', async () => {
  let n = 0;
  const r = await fetchWithRetry(async () => { n += 1; return res(503); }, 'u', undefined, { ...noSleep, attempts: 3 });
  assert.strictEqual(r.status, 503); assert.strictEqual(n, 3);
});

check('a 4xx other than 429 is not retried', async () => {
  let n = 0;
  const r = await fetchWithRetry(async () => { n += 1; return res(400); }, 'u', undefined, noSleep);
  assert.strictEqual(r.status, 400); assert.strictEqual(n, 1);
});

check('Retry-After is honoured, capped at a minute', async () => {
  const waits = []; let n = 0;
  await fetchWithRetry(async () => { n += 1; return n === 1 ? res(429, { 'retry-after': '600' }) : res(200); }, 'u', undefined,
    { sleepImpl: async (ms) => waits.push(ms), baseDelayMs: 1 });
  assert.deepStrictEqual(waits, [60000]);
});

check('a network error on the last attempt is thrown', async () => {
  await assert.rejects(() => fetchWithRetry(async () => { throw new Error('fetch failed'); }, 'u', undefined, { ...noSleep, attempts: 2 }), /fetch failed/);
});

Promise.all(pending).then(() => console.log('\nDone.'));
