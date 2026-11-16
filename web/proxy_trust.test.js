'use strict';
const assert = require('assert');
const express = require('express');
const http = require('http');
const { trustProxy, isCloudflare } = require('./proxy_trust');

assert.strictEqual(isCloudflare('172.70.1.2'), true);
assert.strictEqual(isCloudflare('104.23.0.9'), true);
assert.strictEqual(isCloudflare('::ffff:162.158.3.4'), true);
assert.strictEqual(isCloudflare('2606:4700:10::1'), true);
assert.strictEqual(isCloudflare('8.8.8.8'), false);
assert.strictEqual(isCloudflare('10.0.0.1'), false);
assert.strictEqual(isCloudflare('not an ip'), false);
assert.strictEqual(isCloudflare(''), false);

assert.strictEqual(trustProxy('10.0.0.1', 0), true);
assert.strictEqual(trustProxy('172.70.1.2', 1), true);
assert.strictEqual(trustProxy('203.0.113.5', 1), false);
assert.strictEqual(trustProxy('172.70.1.2', 2), false);

// End to end through Express: what req.ip and req.secure become.
const app = express();
app.set('trust proxy', trustProxy);
app.get('/', (req, res) => res.json({ ip: req.ip, secure: req.secure }));
const server = app.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const get = (headers) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
  });
  try {
    // Via Cloudflare: visitor, then the Cloudflare edge Railway saw.
    let r = await get({ 'x-forwarded-for': '198.51.100.7, 172.70.1.2', 'x-forwarded-proto': 'https' });
    assert.deepStrictEqual(r, { ip: '198.51.100.7', secure: true });
    // Straight to railway.app: one entry, the visitor (unchanged behaviour).
    r = await get({ 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https' });
    assert.deepStrictEqual(r, { ip: '198.51.100.7', secure: true });
    // A forged chain sent straight to railway.app: Railway appends the real
    // address, which is not Cloudflare's, so the forged entry is ignored.
    r = await get({ 'x-forwarded-for': '1.1.1.1, 172.70.1.2, 203.0.113.9', 'x-forwarded-proto': 'https' });
    assert.strictEqual(r.ip, '203.0.113.9');
    // Plain http still reads as not secure.
    r = await get({ 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'http' });
    assert.strictEqual(r.secure, false);
    console.log('proxy_trust: ok');
  } finally { server.close(); }
});
