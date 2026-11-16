// Integration: customer email digests (ADR-20), from real ingests of stubbed
// Austin feeds through the run, the signed job link and the unsubscribe.
// Needs Postgres (DATABASE_URL; default :5433). Sends nothing: the providers
// are the dry run and a stubbed fetch.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_digest_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const recent = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000';
const bp = (num, o = {}) => ({
  permit_number: `2026-${num} BP`, permittype: 'BP', permit_type_desc: 'BP Permit', description: 'New single family',
  status_current: 'Active', issue_date: recent(3), applieddate: recent(20), statusdate: recent(3),
  original_address1: `${num} MAIN ST`, original_city: 'AUSTIN', original_state: 'TX', original_zip: '78701',
  contractor_company_name: 'Acme Builders LLC', contractor_phone: '5125550100', ...o,
});
const trade = (num, type, name) => bp(num, { permit_number: `2026-${num} ${type}`, permittype: type, description: `${type} work`, contractor_company_name: name, contractor_phone: '5125550199' });
const pr = (num, rsn, o = {}) => ({
  permit_number: `2026-${num} PR`, permit_type: 'Plan Review', sub_type: 'R- 101 Single Family Houses', work_class: 'New',
  folder_description: 'New house', folderrsn: rsn, status_current: 'In Review', applied_date: recent(2), status_date: recent(1),
  project_name: `${num} OAK ST`, web_link: { url: `https://abc.austintexas.gov/x?rsn=${rsn}` },
  location: { type: 'Point', coordinates: [-97.74, 30.27] }, ...o,
});

const PEOPLE = ['Jane Doe', 'Smith Family Trust', 'John Q Public', '5125550111', '(512) 555-0111'];
const feeds = {
  '3syk-w9eu': [
    bp(1, { masterpermitnum: '111' }), trade(1, 'EP', 'Sparky Electric LLC'), trade(1, 'PP', 'Pipe Plumbing Inc'),
    bp(6, { masterpermitnum: '666' }), trade(6, 'EP', 'Sparky Electric LLC'),
    bp(7, { masterpermitnum: '777', contractor_company_name: 'Other Homes LLC', contractor_phone: '5125550177' }),
  ],
  'n8ck-xkda': [
    pr(1, '111', { other_organization_name: 'Acme Builders LLC *MAIN*', owner_organization_name: 'Smith Family Trust',
      applicant_full_name: 'Jane Doe', owner_full_name: 'John Q Public', applicant_phone: '5125550111' }),
    pr(6, '666', { applicant_organization_name: 'ACME BUILDERS' }),
    pr(2, '777', { other_organization_name: 'Aqua Permits', applicant_full_name: 'Jane Doe' }),
    pr(4, '444', { other_organization_name: 'Jane Roe' }),
    pr(5, '555', { sub_type: 'R- 105 Five or More Family Bldgs', other_organization_name: 'Big Apartments Development' }),
  ],
};
global.fetch = async (url) => {
  const id = Object.keys(feeds).find((k) => String(url).includes(k));
  return { ok: true, status: 200, json: async () => feeds[id], text: async () => '' };
};

const SECRET = 's'.repeat(40);
const ENV = { LINK_SECRET: SECRET, PUBLIC_BASE_URL: 'https://app.example.com', MAILING_ADDRESS: '100 Congress Ave, Austin, TX 78701' };

function request(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: body ? { 'content-type': 'application/x-www-form-urlencoded' } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const { resolveAll } = require('../../ingest/resolve.js');
  const { runLifecycle } = require('../../ingest/lifecycle.js');
  const { runFilers } = require('../../ingest/filers.js');
  const { parseSubscription, upsert } = require('../../ingest/digest_subscribe.js');
  const { runDigests, isDue } = require('../../src/digest/run.js');
  const { dryRunProvider, resendProvider } = require('../../src/email/providers.js');
  const { sign } = require('../../src/digest/links.js');
  const express = require('express');
  const routes = require('../../web/digest_routes.js');

  const q = async (sql, p) => (await db.query(sql, p)).rows;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-it-'));
  const dry = { ...dryRunProvider({ outDir }), allowlist: [], from: 'Giboro <digest@example.com>', replyTo: null };
  const ingestAll = async () => {
    await ingestArea('austin-tx', { days: 30, max: 100, allDetails: false });
    await ingestArea('austin-plan-review-tx', { days: 30, max: 100, allDetails: false });
    await resolveAll();
    await runLifecycle();
    await runFilers();
  };

  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  let server;
  try {
    await db.applySchema();
    await ingestAll();
    const sub = await upsert(parseSubscription({ email: 'Ops@Acme-Electric.com', area: 'austin-tx', trades: 'electrical', early: 'homes', company: 'Acme Electric' }));
    const subId = Number(sub.id);

    let first;
    await check('a dry run renders one email with new home filings and electrical permits, and records each item', async () => {
      first = await runDigests({ provider: dry, env: ENV });
      assert.deepStrictEqual(first.results.map((r) => [r.subscription, r.status]), [[subId, 'rendered']]);
      const items = await q(`SELECT i.section, p.permit_number FROM digest_items i JOIN permits p ON p.id = i.permit_id ORDER BY 1, 2`);
      assert.deepStrictEqual(items.map((i) => `${i.section} ${i.permit_number}`), [
        'early 2026-1 PR', 'early 2026-2 PR', 'early 2026-4 PR', 'early 2026-6 PR', 'trade:electrical 2026-7 BP',
      ]);
      const [send] = await q('SELECT * FROM digest_sends');
      assert.deepStrictEqual([send.mode, send.status, send.item_count, send.provider], ['dry_run', 'rendered', 5, 'dryrun']);
      assert.match(send.subject, /^Austin: 4 new home filings, 1 for electrical · /);
    });

    await check('the email names the builder with a call button, flags the expediter, and shows no person', async () => {
      const file = fs.readdirSync(outDir).find((f) => f.endsWith('.html'));
      const html = fs.readFileSync(path.join(outDir, file), 'utf8');
      assert.ok(html.includes('Acme Builders LLC') && html.includes('href="tel:+15125550100"'));
      assert.ok(html.includes('Aqua Permits') && html.includes('permit expediter, not the builder'));
      assert.ok(html.includes('Sparky Electric LLC (2 of 2 jobs)'), 'builder past electrical sub');
      assert.ok(html.includes('Other Homes LLC') && html.includes('href="tel:+15125550177"'), 'GC on the trade lead');
      assert.ok(html.includes('https://app.example.com/u/v1.u.'), 'unsubscribe link');
      assert.ok(html.includes('100 Congress Ave'), 'postal address');
      for (const p of PEOPLE) assert.ok(!html.includes(p), `${p} reached the email`);
      const headers = JSON.parse(fs.readFileSync(path.join(outDir, file.replace('.html', '.json')), 'utf8')).headers;
      assert.strictEqual(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
      assert.match(headers['List-Unsubscribe'], /^<https:\/\/app\.example\.com\/u\/v1\.u\./);
    });

    await check('a second run the same day sends nothing and adds no rows', async () => {
      const again = await runDigests({ provider: dry, env: ENV });
      assert.deepStrictEqual(again.results.map((r) => r.status), ['already_done_today']);
      assert.strictEqual((await q('SELECT count(*)::int AS n FROM digest_items'))[0].n, 5);
      assert.strictEqual((await q('SELECT count(*)::int AS n FROM digest_sends'))[0].n, 1);
    });

    await check('the next day carries only what is new; nothing new means no email', async () => {
      await db.query('UPDATE digest_sends SET send_date = send_date - 1');
      const empty = await runDigests({ provider: dry, env: ENV });
      assert.deepStrictEqual(empty.results.map((r) => r.status), ['skipped_empty']);
      await db.query('UPDATE digest_sends SET send_date = send_date - 1');
      feeds['n8ck-xkda'].push(pr(9, '999', { other_organization_name: 'Acme Builders LLC' }));
      feeds['3syk-w9eu'].push(bp(8, { masterpermitnum: '888', contractor_company_name: 'Third Homes LLC' }));
      await ingestAll();
      const next = await runDigests({ provider: dry, env: ENV });
      assert.deepStrictEqual(next.results.map((r) => [r.status, r.items]), [['rendered', 2]]);
      const items = await q(`SELECT i.section, p.permit_number FROM digest_items i JOIN permits p ON p.id = i.permit_id
                              WHERE i.send_id = $1 ORDER BY 1, 2`, [next.results[0].sendId]);
      assert.deepStrictEqual(items.map((i) => `${i.section} ${i.permit_number}`), ['early 2026-9 PR', 'trade:electrical 2026-8 BP']);
    });

    await check('a suppressed phone never reaches the email', async () => {
      await db.query("INSERT INTO suppressions (kind, value, request) VALUES ('phone', '+15125550100', 'remove')");
      await db.query("DELETE FROM digest_items WHERE mode = 'dry_run'");
      await db.query('UPDATE digest_sends SET send_date = send_date - 5, period_end = period_end - interval \'2 days\'');
      for (const f of fs.readdirSync(outDir)) fs.unlinkSync(path.join(outDir, f));
      const r = await runDigests({ provider: dry, env: ENV });
      assert.strictEqual(r.results[0].status, 'rendered');
      const html = fs.readFileSync(path.join(outDir, fs.readdirSync(outDir).find((f) => f.endsWith('.html'))), 'utf8');
      assert.ok(html.includes('Acme Builders LLC'));
      assert.ok(!html.includes('5125550100') && !html.includes('555-0100'));
      await db.query("UPDATE suppressions SET lifted_at = now() WHERE value = '+15125550100'");
    });

    await check('live: provider failures are recorded with their class and retried the same day', async () => {
      let n = 0;
      const fetchImpl = async () => { n += 1; return n === 1 ? { ok: false, status: 503, json: async () => ({ message: 'down' }) } : { ok: true, status: 200, json: async () => ({ id: 'msg_ok' }) }; };
      const live = { ...resendProvider({ apiKey: 'k', fetchImpl }), allowlist: [], from: 'Giboro <digest@example.com>', replyTo: null };
      const bad = await runDigests({ provider: live, env: ENV });
      assert.deepStrictEqual(bad.results.map((r) => [r.status, r.errorClass]), [['failed', 'provider_down']]);
      assert.strictEqual(bad.failed, 1);
      const [row] = await q("SELECT status, error_class, error_message FROM digest_sends WHERE mode = 'live'");
      assert.deepStrictEqual([row.status, row.error_class, row.error_message], ['failed', 'provider_down', 'down']);
      assert.strictEqual((await q("SELECT count(*)::int AS n FROM digest_items WHERE mode = 'live'"))[0].n, 0, 'no items on a failed send');
      const ok = await runDigests({ provider: live, env: ENV });
      assert.deepStrictEqual(ok.results.map((r) => r.status), ['sent']);
      const [sent] = await q("SELECT status, provider_message_id, item_count FROM digest_sends WHERE mode = 'live'");
      assert.deepStrictEqual([sent.status, sent.provider_message_id], ['sent', 'msg_ok']);
      assert.ok(sent.item_count > 0);
      const again = await runDigests({ provider: live, env: ENV });
      assert.deepStrictEqual(again.results.map((r) => r.status), ['already_done_today']);
      assert.strictEqual(n, 2, 'no third provider call');
    });

    await check('live: an allowlist keeps real sends to the listed addresses', async () => {
      const other = await upsert(parseSubscription({ email: 'someone@else.com', area: 'austin-tx', trades: 'plumbing' }));
      const live = { ...resendProvider({ apiKey: 'k', fetchImpl: async () => { throw new Error('should not send'); } }), allowlist: ['ops@acme-electric.com'], from: 'x@example.com', replyTo: null };
      const r = await runDigests({ provider: live, env: ENV, only: Number(other.id) });
      assert.deepStrictEqual(r.results.map((x) => x.status), ['skipped_allowlist']);
      await db.query('DELETE FROM digest_subscriptions WHERE id = $1', [other.id]);
    });

    await check('weekly subscriptions are due on their weekday only', async () => {
      assert.strictEqual(isDue({ frequency: 'weekly', send_weekday: 1 }, new Date('2026-11-16T17:00:00Z')), true);
      assert.strictEqual(isDue({ frequency: 'weekly', send_weekday: 1 }, new Date('2026-11-17T17:00:00Z')), false);
      assert.strictEqual(isDue({ frequency: 'daily', send_weekday: 1 }, new Date('2026-11-17T17:00:00Z')), true);
    });

    const app = express();
    app.use(routes.publicRouter({ env: ENV }));
    app.use(routes.previewRouter({ env: ENV }));
    server = app.listen(0);
    const port = server.address().port;
    const [filing] = await q("SELECT id FROM permits WHERE permit_number = '2026-1 PR'");
    const [lead] = await q("SELECT id FROM permits WHERE permit_number = '2026-7 BP'");
    const jobToken = (id, o = {}) => sign(SECRET, { kind: 'j', subscriptionId: subId, targetId: id, expiresAt: Date.now() + 86400000, ...o });

    await check('a signed link opens one filing without a login: builder, call button, past subs, no person', async () => {
      const r = await request(port, 'GET', `/l/${jobToken(filing.id)}`);
      assert.strictEqual(r.status, 200);
      assert.match(r.headers['cache-control'], /no-store/);
      assert.strictEqual(r.headers['referrer-policy'], 'no-referrer');
      assert.ok(r.body.includes('1 OAK ST') && r.body.includes('Acme Builders LLC') && r.body.includes('href="tel:+15125550100"'));
      assert.ok(r.body.includes('Sparky Electric LLC'));
      for (const p of PEOPLE) assert.ok(!r.body.includes(p), `${p} on the job page`);
      const l = await request(port, 'GET', `/l/${jobToken(lead.id)}`);
      assert.ok(l.status === 200 && l.body.includes('Other Homes LLC') && l.body.includes('No electrical permit on this job'));
    });

    await check('tampered, expired and unknown-subscription links are refused', async () => {
      const t = jobToken(filing.id);
      assert.strictEqual((await request(port, 'GET', `/l/${t.replace(`.${filing.id}.`, `.${lead.id}.`)}`)).status, 404);
      assert.strictEqual((await request(port, 'GET', `/l/${jobToken(filing.id, { expiresAt: Date.now() - 1000 })}`)).status, 404);
      assert.strictEqual((await request(port, 'GET', `/l/${sign(SECRET, { kind: 'j', subscriptionId: 999, targetId: filing.id, expiresAt: Date.now() + 9e6 })}`)).status, 404);
      assert.strictEqual((await request(port, 'GET', `/l/${sign(SECRET, { kind: 'u', subscriptionId: subId })}`)).status, 404, 'an unsubscribe token is not a job link');
    });

    await check('previews render from live data and record nothing', async () => {
      const before = (await q('SELECT count(*)::int AS n FROM digest_sends'))[0].n;
      const s = await request(port, 'GET', '/digest/sample?source=austin-tx&trades=electrical&early=homes&days=7');
      assert.ok(s.status === 200 && s.body.includes('Preview only') && s.body.includes('New home filings'));
      const one = await request(port, 'GET', `/digest/preview/${subId}`);
      assert.strictEqual(one.status, 200);
      const list = await request(port, 'GET', '/digest/preview');
      assert.ok(list.body.includes(`/digest/preview/${subId}`) && !list.body.includes('acme-electric.com'), 'no address on the list');
      assert.strictEqual((await q('SELECT count(*)::int AS n FROM digest_sends'))[0].n, before);
    });

    await check('unsubscribe: GET only asks; one-click POST suppresses the address and stops every subscription', async () => {
      const second = await upsert(parseSubscription({ email: 'ops@acme-electric.com', label: 'weekly', area: 'raleigh-nc', trades: 'plumbing', frequency: 'weekly' }));
      const t = sign(SECRET, { kind: 'u', subscriptionId: subId });
      const g = await request(port, 'GET', `/u/${t}`);
      assert.ok(g.status === 200 && g.body.includes('<form method="post"') && g.body.includes('o•••@acme-electric.com'));
      assert.strictEqual((await q('SELECT count(*)::int AS n FROM email_suppressions'))[0].n, 0, 'a GET must not unsubscribe');
      const p = await request(port, 'POST', `/u/${t}`, 'List-Unsubscribe=One-Click');
      assert.ok(p.status === 200 && p.body.includes('You are unsubscribed'));
      const sup = await q('SELECT email, reason, channel FROM email_suppressions');
      assert.deepStrictEqual(sup.map((s) => [s.email, s.reason, s.channel]), [['ops@acme-electric.com', 'unsubscribe', 'one_click']]);
      const subs = await q('SELECT id, status FROM digest_subscriptions ORDER BY id');
      assert.deepStrictEqual(subs.map((s) => s.status), ['unsubscribed', 'unsubscribed']);
      assert.strictEqual((await request(port, 'POST', `/u/${t}`, '')).status, 200, 'a repeat is harmless');
      assert.strictEqual((await q('SELECT count(*)::int AS n FROM email_suppressions'))[0].n, 1);
      await db.query('UPDATE digest_sends SET send_date = send_date - 1');
      const r = await runDigests({ provider: dry, env: ENV });
      assert.deepStrictEqual(r.results, [], 'nothing sent after unsubscribe');
      // Re-adding the address does not lift the opt-out.
      await db.query("UPDATE digest_subscriptions SET status = 'active', frequency = 'daily' WHERE id = $1", [second.id]);
      const r2 = await runDigests({ provider: dry, env: ENV });
      assert.deepStrictEqual(r2.results.map((x) => x.status), ['skipped_suppressed']);
    });
  } finally {
    if (server) server.close();
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) { console.error(`\n${failures} digest integration test(s) failed`); process.exit(1); }
  console.log('\nall digest integration tests passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
