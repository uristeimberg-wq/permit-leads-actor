// The telemetry endpoint (web/telemetry.js) with an in-memory store: strict
// validation, redaction on the server, DNT, size and rate limits, owner and
// bot marking, the signed-in user passed to the store. No database.
const assert = require('node:assert');
const express = require('express');
const t = require('./telemetry.js');

let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log(`ok   - ${name}`); } catch (e) { failures += 1; console.error(`FAIL - ${name}`); console.error(e); } };

const SID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const EID = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ev = (n, o = {}) => ({ event_id: EID(n), event_name: 'page_view', client_timestamp: new Date().toISOString(), page_path: '/', properties: {}, ...o });
const batch = (events, o = {}) => ({ session_id: SID, anonymous_device_id: DID, session: { entry_path: '/', referrer: 'google.com' }, events, ...o });

async function withApp(deps, fn) {
  const calls = [];
  const store = { ingest: async (x) => { calls.push(x); return deps.result || { accepted: x.events.length, duplicates: 0 }; } };
  const app = express();
  app.set('trust proxy', 1);
  app.use(t.router({ store, ...deps }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/api/telemetry/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': CHROME, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  try { await fn(post, calls); } finally { server.close(); }
}

(async () => {
  await check('validateBatch: a good batch is cleaned and categorised', () => {
    const out = t.validateBatch(batch([ev(1, { event_name: 'search_executed', properties: { query: 'roof bob@x.com', results_count: 0, zero_results: true, token: 'abc' } })]));
    assert.ok(!out.error, out.error);
    assert.strictEqual(out.events[0].event_category, 'search');
    assert.deepStrictEqual(out.events[0].properties, { query: 'roof [email]', results_count: 0, zero_results: true });
    assert.strictEqual(out.session.referrer, 'google.com');
  });

  await check('validateBatch refuses malformed batches whole', () => {
    const bad = [
      [{}, /session_id/], [batch([], {}), /non-empty/], [batch([ev(1)], { session_id: 'x' }), /session_id/],
      [batch([ev(1, { event_name: 'made_up' })]), /taxonomy/], [batch([ev(1, { event_id: 'nope' })]), /event_id/],
      [batch([ev(1, { client_timestamp: 'yesterday' })]), /client_timestamp/], [batch([ev(1, { page_path: '/?q=a@b.co' })]), /page_path/],
      [batch([ev(1, { target_entity_type: 'user' })]), /target_entity_type/], [batch([ev(1, { target_record_id: '<script>' })]), /target_record_id/],
      [batch(Array.from({ length: 51 }, (_, i) => ev(i))), /At most 50/],
    ];
    for (const [b, re] of bad) assert.match(t.validateBatch(b).error || '', re);
  });

  await check('validateBatch: duplicate ids in one batch kept once; a wild clock is clamped', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    const out = t.validateBatch(batch([ev(1, { client_timestamp: '2020-01-01T00:00:00Z' }), ev(1)]), now);
    assert.strictEqual(out.events.length, 1);
    assert.strictEqual(out.events[0].client_timestamp, new Date(now).toISOString());
  });

  await check('a referrer that is not a bare host is dropped', () => {
    assert.strictEqual(t.validateBatch(batch([ev(1)], { session: { referrer: 'https://x.com/a?email=a@b.co' } })).session.referrer, null);
  });

  await check('user-agent families; bots and headless browsers are flagged', () => {
    assert.deepStrictEqual(t.parseUserAgent(CHROME), { device_type: 'desktop', browser: 'Chrome', os: 'macOS', bot: false });
    const iphone = t.parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
    assert.deepStrictEqual(iphone, { device_type: 'mobile', browser: 'Safari', os: 'iOS', bot: false });
    assert.strictEqual(t.parseUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)').device_type, 'tablet');
    for (const ua of ['Googlebot/2.1', 'Mozilla/5.0 HeadlessChrome/130', 'curl/8.0', '', 'node']) assert.strictEqual(t.parseUserAgent(ua).bot, true, ua);
  });

  await check('geo only from a configured header, never the IP', () => {
    const req = (h) => ({ get: (k) => h[k.toLowerCase()] });
    assert.deepStrictEqual(t.geoFrom(req({ 'cf-ipcountry': 'US' }), {}), { ip_country: null, ip_region: null });
    assert.deepStrictEqual(t.geoFrom(req({ 'cf-ipcountry': 'us' }), { GEO_COUNTRY_HEADER: 'cf-ipcountry' }), { ip_country: 'US', ip_region: null });
    assert.strictEqual(t.geoFrom(req({ 'cf-ipcountry': 'XX' }), { GEO_COUNTRY_HEADER: 'cf-ipcountry' }).ip_country, null);
  });

  await check('POST: 202 with the store result; user, owner flag and UA families passed', () => withApp({ userIdOf: () => 7, isOwner: () => false }, async (post, calls) => {
    const r = await post(batch([ev(1), ev(2)]));
    assert.strictEqual(r.status, 202);
    assert.deepStrictEqual(await r.json(), { accepted: 2, duplicates: 0 });
    assert.strictEqual(calls[0].userId, 7);
    assert.strictEqual(calls[0].internal, false);
    assert.strictEqual(calls[0].ua.browser, 'Chrome');
    assert.ok(!('ip' in calls[0]) && !JSON.stringify(calls[0]).includes('127.0.0.1'), 'the IP never reaches the store');
  }));

  await check('owner key or the client flag marks the session internal', () => withApp({ isOwner: () => true }, async (post, calls) => {
    await post(batch([ev(1)]));
    assert.strictEqual(calls[0].internal, true);
  }).then(() => withApp({}, async (post, calls) => {
    await post(batch([ev(1)], { internal: true }));
    assert.strictEqual(calls[0].internal, true);
  })));

  await check('DNT and GPC are acknowledged and nothing is stored', () => withApp({}, async (post, calls) => {
    assert.strictEqual((await post(batch([ev(1)]), { dnt: '1' })).status, 204);
    assert.strictEqual((await post(batch([ev(1)]), { 'sec-gpc': '1' })).status, 204);
    assert.strictEqual(calls.length, 0);
  }));

  await check('malformed JSON 400, oversize 413, bad batch 400, beacon text/plain accepted', () => withApp({}, async (post, calls) => {
    assert.strictEqual((await post('{nope')).status, 400);
    assert.strictEqual((await post(JSON.stringify(batch([ev(1, { properties: { x: 'a'.repeat(70000) } })])))).status, 413);
    assert.strictEqual((await post(batch([ev(1, { event_name: 'nope' })]))).status, 400);
    assert.strictEqual((await post(batch([ev(1)]), { 'content-type': 'text/plain;charset=UTF-8' })).status, 202);
    assert.strictEqual(calls.length, 1);
  }));

  await check('rate limited per IP', () => withApp({ limiter: t.rateLimiter({ perMinute: 3 }) }, async (post) => {
    assert.strictEqual((await post(batch([ev(1), ev(2), ev(3)]))).status, 202);
    assert.strictEqual((await post(batch([ev(4)]))).status, 429);
  }));

  await check('a session id owned by another device is 409; a store failure is 503', () => withApp({ result: { conflict: true } }, async (post) => {
    assert.strictEqual((await post(batch([ev(1)]))).status, 409);
  }).then(async () => {
    const app = express();
    const err = console.error; console.error = () => {};
    app.use(t.router({ store: { ingest: async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); } } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/telemetry/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': CHROME }, body: JSON.stringify(batch([ev(1)])) });
      assert.strictEqual(r.status, 503);
    } finally { server.close(); console.error = err; }
  }));

  if (failures) { console.error(`${failures} failed`); process.exit(1); }
})();
