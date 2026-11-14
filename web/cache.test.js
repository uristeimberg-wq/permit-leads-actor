// Unit: web/cache.js (offline, no DB). Fresh hits, stale-while-revalidate,
// blocking misses, de-duplicated computes, failures, gzip, ETag/304, LRU.

const assert = require('node:assert');
const zlib = require('node:zlib');
const { createCache } = require('./cache.js');

let clock = 0;
const now = () => clock;
const logs = [];
const make = (o = {}) => createCache({ freshMs: 1000, staleMs: 10000, max: 3, enabled: true, now, log: (m) => logs.push(m), ...o });
const tick = () => new Promise((r) => setImmediate(r));

function fakeRes() {
  const res = { headers: {}, code: 200, body: null };
  res.set = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.type = (t) => res.set('content-type', t);
  res.status = (c) => { res.code = c; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.end = () => res;
  res.json = (o) => { res.body = Buffer.from(JSON.stringify(o)); return res; };
  return res;
}
const fakeReq = (h = {}, url = '/x') => ({ originalUrl: url, get: (k) => h[k.toLowerCase()] });

(async () => {
  let calls = 0;
  const compute = async () => { calls += 1; return { n: calls }; };

  // miss, then hit
  let c = make();
  let r = await c.get('k', compute);
  assert.deepStrictEqual([r.state, JSON.parse(r.entry.body).n], ['miss', 1]);
  r = await c.get('k', compute);
  assert.deepStrictEqual([r.state, JSON.parse(r.entry.body).n, calls], ['hit', 1, 1]);

  // stale: old answer at once, new one computed in the background
  clock = 1500;
  r = await c.get('k', compute);
  assert.deepStrictEqual([r.state, JSON.parse(r.entry.body).n], ['stale', 1]);
  await tick(); await tick();
  r = await c.get('k', compute);
  assert.deepStrictEqual([r.state, JSON.parse(r.entry.body).n, calls], ['hit', 2, 2]);

  // too old: blocks and recomputes
  clock = 20000;
  r = await c.get('k', compute);
  assert.deepStrictEqual([r.state, JSON.parse(r.entry.body).n], ['miss', 3]);

  // concurrent misses share one compute
  calls = 0; clock = 0; c = make();
  const [a, b] = await Promise.all([c.get('j', compute), c.get('j', compute)]);
  assert.strictEqual(calls, 1);
  assert.strictEqual(a.entry, b.entry);

  // a failed background refresh keeps the old answer and logs
  clock = 1500;
  r = await c.get('j', async () => { throw new Error('db down'); });
  assert.strictEqual(r.state, 'stale');
  await tick(); await tick();
  assert.ok(logs.some((m) => m.includes('db down')));
  assert.strictEqual(JSON.parse((await c.get('j', compute)).entry.body).n, 1);

  // a failed blocking compute rejects and stores nothing
  await assert.rejects(c.get('new', async () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual((await c.get('new', compute)).state, 'miss');

  // LRU bound
  clock = 0; c = make();
  for (const k of ['a', 'b', 'c', 'd']) await c.get(k, compute);
  assert.strictEqual(c.size(), 3);
  calls = 0;
  assert.strictEqual((await c.get('a', compute)).state, 'miss');

  // disabled: always computes
  c = make({ enabled: false });
  calls = 0;
  await c.get('k', compute); await c.get('k', compute);
  assert.strictEqual(calls, 2);

  // route + send: gzip when accepted, plain otherwise, 304 on ETag, errors as 500, non-200 kept
  clock = 0; c = make();
  const big = { rows: Array.from({ length: 200 }, (_, i) => ({ i, text: 'permit row' })) };
  const handler = c.route(async () => big);
  let res = fakeRes();
  await handler(fakeReq({ 'accept-encoding': 'gzip, br' }), res);
  assert.strictEqual(res.headers['content-encoding'], 'gzip');
  assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(res.body)), big);
  assert.strictEqual(res.headers['x-cache'], 'miss');
  const { etag } = res.headers;
  res = fakeRes();
  await handler(fakeReq({}), res);
  assert.strictEqual(res.headers['content-encoding'], undefined);
  assert.deepStrictEqual(JSON.parse(res.body), big);
  assert.strictEqual(res.headers['x-cache'], 'hit');
  res = fakeRes();
  await handler(fakeReq({ 'if-none-match': etag }), res);
  assert.strictEqual(res.code, 304);

  res = fakeRes();
  const origErr = console.error; console.error = () => {};
  await c.route(async () => { throw new Error('SELECT secret FROM x'); })(fakeReq({}, '/err'), res);
  console.error = origErr;
  assert.strictEqual(res.code, 500);
  assert.ok(!String(res.body).includes('secret'));

  res = fakeRes();
  await c.route(async () => ({ status: 404, json: { error: 'Permit not found' } }))(fakeReq({}, '/nf'), res);
  assert.deepStrictEqual([res.code, JSON.parse(res.body).error], [404, 'Permit not found']);

  console.log('web/cache.test.js: all passed');
})().catch((err) => { console.error(err); process.exit(1); });
