const assert = require('node:assert');
const { demoGate } = require('./access.js');

function run(gate, auth) {
  let status = 200; let nextCalled = false;
  const res = { set() {}, status(s) { status = s; return this; }, send() { return this; } };
  gate({ headers: auth ? { authorization: auth } : {} }, res, () => { nextCalled = true; });
  return { status, nextCalled };
}
const basic = (s) => `Basic ${Buffer.from(s).toString('base64')}`;
const check = (name, fn) => { try { fn(); console.log(`ok   - ${name}`); } catch (e) { console.error(`FAIL - ${name}`); console.error(e); process.exitCode = 1; } };

check('no password configured: open', () => assert.strictEqual(run(demoGate(''), null).nextCalled, true));
check('password set, no header: 401', () => assert.strictEqual(run(demoGate('s3cret'), null).status, 401));
check('wrong password: 401', () => assert.strictEqual(run(demoGate('s3cret'), basic('sales:nope')).status, 401));
check('right password, any user: passes', () => assert.strictEqual(run(demoGate('s3cret'), basic('anyone:s3cret')).nextCalled, true));
check('password containing a colon', () => assert.strictEqual(run(demoGate('a:b'), basic('u:a:b')).nextCalled, true));
