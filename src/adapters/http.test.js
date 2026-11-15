const assert = require('node:assert');
const { fetchWithRetry, retryAfterMs, retryTally } = require('./http.js');

const pending = [];
function check(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => console.log(`ok   - ${name}`),
    (err) => { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; },
  ));
}
const res = (status, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k] ?? null } });
const noSleep = { sleepImpl: async () => {}, baseDelayMs: 1, randomImpl: () => 1 };

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

check('Retry-After may be an HTTP date', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  assert.strictEqual(retryAfterMs('Sun, 15 Nov 2026 12:00:30 GMT', now), 30000);
  assert.strictEqual(retryAfterMs('5', now), 5000);
  assert.strictEqual(retryAfterMs('soon', now), null);
  assert.strictEqual(retryAfterMs(null, now), null);
});

check('backoff is exponential with jitter between half and all of each step', async () => {
  const waits = [];
  let n = 0;
  await fetchWithRetry(async () => { n += 1; return n < 4 ? res(503) : res(200); }, 'u', undefined,
    { sleepImpl: async (ms) => waits.push(ms), baseDelayMs: 1000, randomImpl: () => 0 });
  assert.deepStrictEqual(waits, [500, 1000, 2000]);
});

check('every retry is reported, so a run can record rate limits', async () => {
  const tally = retryTally();
  let n = 0;
  await fetchWithRetry(async () => {
    n += 1;
    if (n === 1) return res(429);
    if (n === 2) throw new Error('fetch failed');
    if (n === 3) return res(503);
    return res(200);
  }, 'u', undefined, { ...noSleep, onRetry: tally.onRetry });
  assert.deepStrictEqual({ r: tally.retries, rl: tally.rateLimited, s: tally.serverErrors, ne: tally.networkErrors }, { r: 3, rl: 1, s: 1, ne: 1 });
});

Promise.all(pending).then(() => console.log('\nDone.'));
