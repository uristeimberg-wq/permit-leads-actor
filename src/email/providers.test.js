// Unit: email providers (src/email/providers.js). Offline: fetch is stubbed.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('./providers.js');

let failures = 0;
const tests = [];
const check = (name, fn) => tests.push([name, fn]);

const READY = {
  EMAIL_PROVIDER: 'resend', EMAIL_SEND_ENABLED: 'yes', EMAIL_API_KEY: 're_test_123', EMAIL_FROM: 'Contractos <digest@mail.example.com>',
  MAILING_ADDRESS: '100 Congress Ave, Austin, TX 78701', LINK_SECRET: 'z'.repeat(40), PUBLIC_BASE_URL: 'https://app.example.com',
};
const msg = { key: 'digest-1', to: 'a@b.com', from: 'Contractos <digest@mail.example.com>', subject: 'S', html: '<p>h</p>', text: 't',
  headers: { 'List-Unsubscribe': '<https://app.example.com/u/x>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };

function stub(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: status < 300, status, json: async () => body }; };
  return { fetchImpl, calls };
}

check('no provider set: dry run that writes files and sends nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
  const p = P.providerFromEnv({ DIGEST_OUT_DIR: dir }, { fetchImpl: () => { throw new Error('network used'); } });
  assert.deepStrictEqual([p.name, p.mode], ['dryrun', 'dry_run']);
  assert.match(p.note, /nothing is sent/);
  const r = await p.send(msg);
  assert.strictEqual(r.id, 'dry-run:digest-1');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'digest-1.html'), 'utf8'), '<p>h</p>');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'digest-1.json'), 'utf8')).headers, msg.headers);
});

check('a provider without EMAIL_SEND_ENABLED=yes stays a dry run', async () => {
  const p = P.providerFromEnv({ ...READY, EMAIL_SEND_ENABLED: '' });
  assert.strictEqual(p.mode, 'dry_run');
  assert.match(p.note, /EMAIL_SEND_ENABLED/);
});

check('real sends refuse until every CAN-SPAM and link setting is present, listing each', async () => {
  assert.throws(() => P.providerFromEnv({ EMAIL_PROVIDER: 'resend', EMAIL_SEND_ENABLED: 'yes' }), (e) => {
    assert.strictEqual(e.errorClass, 'config');
    for (const k of ['EMAIL_API_KEY', 'EMAIL_FROM', 'MAILING_ADDRESS', 'LINK_SECRET', 'PUBLIC_BASE_URL']) assert.ok(e.message.includes(k), k);
    return true;
  });
  assert.throws(() => P.providerFromEnv({ ...READY, PUBLIC_BASE_URL: 'http://insecure.example.com' }), /PUBLIC_BASE_URL/);
  assert.throws(() => P.providerFromEnv({ ...READY, EMAIL_PROVIDER: 'mailchimp' }), /not one of/);
  assert.deepStrictEqual(P.liveConfigProblems(READY), []);
});

check('Resend: bearer key, idempotency key, one-click headers, message id', async () => {
  const s = stub(200, { id: 'msg_1' });
  const p = P.providerFromEnv({ ...READY, EMAIL_ALLOWLIST: 'Me@Example.com, b@c.com' }, { fetchImpl: s.fetchImpl });
  assert.deepStrictEqual([p.mode, p.allowlist], ['live', ['me@example.com', 'b@c.com']]);
  assert.deepStrictEqual(await p.send(msg), { id: 'msg_1' });
  const c = s.calls[0];
  assert.strictEqual(c.url, 'https://api.resend.com/emails');
  assert.strictEqual(c.init.headers.authorization, 'Bearer re_test_123');
  assert.strictEqual(c.init.headers['idempotency-key'], 'digest-1');
  assert.deepStrictEqual([c.body.to, c.body.headers['List-Unsubscribe-Post']], [['a@b.com'], 'List-Unsubscribe=One-Click']);
});

check('Postmark: server token, headers as a list, no open or link tracking', async () => {
  const s = stub(200, { MessageID: 'pm-1', ErrorCode: 0 });
  const p = P.providerFromEnv({ ...READY, EMAIL_PROVIDER: 'postmark' }, { fetchImpl: s.fetchImpl });
  assert.deepStrictEqual(await p.send(msg), { id: 'pm-1' });
  const c = s.calls[0];
  assert.strictEqual(c.url, 'https://api.postmarkapp.com/email');
  assert.strictEqual(c.init.headers['x-postmark-server-token'], 're_test_123');
  assert.deepStrictEqual(c.body.Headers.map((h) => h.Name), ['List-Unsubscribe', 'List-Unsubscribe-Post']);
  assert.deepStrictEqual([c.body.MessageStream, c.body.TrackOpens, c.body.TrackLinks], ['broadcast', false, 'None']);
});

check('provider failures carry an error class and never the API key', async () => {
  const cases = [[401, 'auth'], [403, 'auth'], [429, 'rate_limit'], [422, 'rejected'], [503, 'provider_down']];
  for (const [status, cls] of cases) {
    const s = stub(status, { message: 'nope' });
    const p = P.providerFromEnv(READY, { fetchImpl: s.fetchImpl });
    await assert.rejects(p.send(msg), (e) => e.errorClass === cls && !e.message.includes('re_test_123'));
  }
  const down = P.providerFromEnv(READY, { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(down.send(msg), (e) => e.errorClass === 'network');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  }
  if (failures) { console.error(`\n${failures} email provider test(s) failed`); process.exit(1); }
  console.log('\nall email provider tests passed');
})();
