// Unit: the digest email (src/digest/render.js). Offline, no database.
const assert = require('node:assert');
const { renderDigest, subjectFor, phoneText } = require('./render.js');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
};

const phone = (v) => ({ value: v, verification: 'corroborated', seenOnPermits: 4 });
function model(over = {}) {
  return {
    subscription: { id: 4, email: 'ops@acme-electric.com', company: 'Acme Electric', sourceArea: 'austin-tx', trades: ['electrical'], earlySegment: 'homes', frequency: 'daily' },
    market: {
      city: 'Austin', source: 'austin-tx', attribution: null, lastSyncAt: '2026-11-14T17:20:00Z', lastSyncStatus: 'succeeded',
      publicationLag: 'Austin publishes permits 2-3 days after issue', earlyLag: 'Plan-review cases are published the same day they are applied for',
      earlySource: 'austin-plan-review-tx', earlyLastSyncAt: '2026-11-14T17:22:00Z',
    },
    period: { start: '2026-11-13T17:30:00Z', end: '2026-11-14T17:30:00Z' },
    early: {
      title: 'New home filings', noun: { one: 'new home filing', many: 'new home filings' }, note: 'Applications filed with the city and not issued yet.',
      items: [
        { id: 11, permitNumber: '2026-1 PR', address: '1 Oak St', zip: '78701', permitType: 'R- 101 Single Family Houses', valuation: 420000,
          stage: 'in_review', submittedOn: '2026-11-12', firstSeenAt: '2026-11-13T18:00:00Z', url: 'https://abc.austintexas.gov/x?rsn=1',
          filer: { name: 'Acme Builders LLC', role: 'builder', basis: 'pulled 2 of the 2' }, filerWithheld: false,
          builderSubs: [{ trade: 'electrical', sub: { name: 'Sparky Electric LLC' }, jobs: 2, tradeJobs: 3 }, { trade: 'plumbing', sub: { name: 'Pipe Co' }, jobs: 1, tradeJobs: 1 }],
          builderPhone: phone('+15125550100') },
        { id: 12, permitNumber: '2026-2 PR', address: '2 Oak <St>', zip: null, permitType: 'R- 101', valuation: null, stage: 'submitted',
          submittedOn: null, firstSeenAt: '2026-11-13T18:00:00Z', url: 'javascript:alert(1)',
          filer: { name: 'Aqua Permits', role: 'expediter', basis: 'name says permit' }, filerWithheld: false, builderSubs: [], builderPhone: phone('+15125550111') },
        { id: 13, permitNumber: '2026-3 PR', address: '3 Oak St', zip: '78702', permitType: 'R- 102', valuation: 1, stage: 'in_review',
          submittedOn: '2026-11-12', firstSeenAt: '2026-11-13T18:00:00Z', url: null, filer: null, filerWithheld: true, builderSubs: [], builderPhone: null },
      ],
      more: 2,
    },
    earlyUnavailable: false,
    trades: [{
      trade: 'electrical',
      items: [{ id: 21, permitNumber: '2026-9 BP', address: '9 Elm St', zip: '78703', permitType: 'BP', description: 'New house <script>x</script>',
        valuation: 300000, issuedOn: '2026-11-11', firstSeenAt: '2026-11-14T17:10:00Z', url: 'https://abc.austintexas.gov/p/9', score: 80,
        gc: { id: 5, name: 'Big & Co Homes', phone: phone('+15125550122') } },
      { id: 22, permitNumber: '2026-10 BP', address: '10 Elm St', zip: '78703', permitType: 'BP', description: null, valuation: 1, issuedOn: null,
        firstSeenAt: '2026-11-14T17:10:00Z', url: null, score: 40, gc: { id: null, name: null, withheld: 'Looks like an individual' } }],
      more: 0,
    }],
    items: [],
    ...over,
  };
}
const links = { job: (id) => `https://app.example.com/l/tok-${id}`, unsubscribe: () => 'https://app.example.com/u/unsub-tok' };
const opts = { mailingAddress: 'Giboro, 100 Congress Ave Suite 200, Austin, TX 78701', contactEmail: 'hello@example.com', appUrl: 'https://app.example.com' };

check('subject counts what is new, by section, in the market', () => {
  assert.strictEqual(subjectFor(model()), 'Austin: 5 new home filings, 2 for electrical · Nov 14');
});

check('CAN-SPAM: unsubscribe link and postal address in HTML and text; placeholder when unset', () => {
  const e = renderDigest(model(), links, opts);
  for (const body of [e.html, e.text]) {
    assert.ok(body.includes('https://app.example.com/u/unsub-tok'), 'unsubscribe');
    assert.ok(body.includes('100 Congress Ave Suite 200'), 'address');
  }
  const bare = renderDigest(model(), links, {});
  assert.ok(bare.html.includes('Mailing address not set') && bare.text.includes('Mailing address not set'));
});

check('builder gets a tap-to-call button and its past subs for the subscribed trade only', () => {
  const { html } = renderDigest(model(), links, opts);
  assert.ok(html.includes('href="tel:+15125550100"') && html.includes('Call (512) 555-0100'));
  assert.ok(html.includes('Sparky Electric LLC (2 of 3 jobs)'));
  assert.ok(!html.includes('Pipe Co'), 'plumbing sub shown to an electrical subscriber');
  assert.ok(html.includes('href="tel:+15125550122"'), 'GC phone on a trade lead');
});

check('an expediter is flagged and its phone is not offered as the builder\'s', () => {
  const { html, text } = renderDigest(model(), links, opts);
  assert.ok(html.includes('Expediter') && html.includes('permit expediter, not the builder'));
  assert.ok(!html.includes('tel:+15125550111'));
  assert.ok(text.includes('Aqua Permits (permit expediter, not the builder)'));
  assert.ok(!text.includes('(512) 555-0111'));
});

check('individuals are withheld; third-party text is escaped; bad URLs are not linked', () => {
  const { html } = renderDigest(model(), links, opts);
  assert.ok(html.includes('Filed by an individual (name withheld)'));
  assert.ok(html.includes('An individual (name withheld)'));
  assert.ok(!html.includes('<script>x') && html.includes('&lt;script&gt;'));
  assert.ok(html.includes('2 Oak &lt;St&gt;') && html.includes('Big &amp; Co Homes'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('href="https://abc.austintexas.gov/x?rsn=1"'), 'official record link');
});

check('every item links to its signed job page; "more" points to the app', () => {
  const { html, text } = renderDigest(model(), links, opts);
  for (const id of [11, 12, 13, 21, 22]) {
    assert.ok(html.includes(`https://app.example.com/l/tok-${id}`), `html ${id}`);
    assert.ok(text.includes(`https://app.example.com/l/tok-${id}`), `text ${id}`);
  }
  assert.ok(html.includes('2 more in the app') && text.includes('2 more in the app'));
});

check('freshness: last sync and publication lag stated; a failed sync is called out', () => {
  const ok = renderDigest(model(), links, opts);
  assert.ok(ok.html.includes('Austin publishes permits 2-3 days after issue'));
  assert.ok(ok.html.includes('Permits as of the last Austin sync'));
  assert.ok(ok.html.includes('Filings as of the last application sync'));
  assert.ok(!ok.html.includes('sync attempt failed'));
  const bad = renderDigest(model({ market: { ...model().market, lastSyncStatus: 'failed' } }), links, opts);
  assert.ok(bad.html.includes('The latest Austin sync attempt failed'));
  const old = renderDigest(model({ market: { ...model().market, lastSyncAt: '2026-11-10T00:00:00Z' } }), links, opts);
  assert.ok(old.html.includes('more than a day old'));
});

check('the credit line names the sources; CC BY credit for City of Miami', () => {
  const { html } = renderDigest(model(), links, opts);
  assert.ok(html.includes('dataset 3syk-w9eu') && html.includes('dataset n8ck-xkda'));
  const miami = renderDigest(model({ early: null, subscription: { ...model().subscription, sourceArea: 'miami-city-fl' },
    market: { ...model().market, city: 'City of Miami', source: 'miami-city-fl' } }), links, opts);
  assert.ok(miami.html.includes('Licensed CC BY 4.0'));
});

check('no banned sales claims anywhere in the email', () => {
  const { html, text } = renderDigest(model(), links, opts);
  const words = `${html}\n${text}`.replace(/<[^>]+>/g, ' ');
  for (const re of [/\bverified\b/i, /\bunhired\b/i, /real-time/i, /\blive\b/i, /open now/i]) assert.ok(!re.test(words), `${re} found`);
});

check('phone-friendly: viewport, one 600px column, 44px buttons, preheader', () => {
  const { html, preheader } = renderDigest(model(), links, opts);
  assert.ok(html.includes('name="viewport"') && html.includes('max-width:600px'));
  assert.ok(/padding:12px 18px;min-height:20px;font:700 16px\/20px/.test(html), '12+20+12 = 44px tap target');
  assert.ok(preheader.startsWith('7 new records in Austin'));
});

check('empty sections say so; a market without early filings says why', () => {
  const m = model({ early: { ...model().early, items: [], more: 0 }, trades: [{ trade: 'plumbing', items: [], more: 0 }] });
  const { html } = renderDigest(m, links, opts);
  assert.ok(html.includes('No new filings since the last email') && html.includes('No new permits since the last email'));
  const none = renderDigest(model({ early: null, earlyUnavailable: true }), links, opts);
  assert.ok(none.html.includes('publishes issued permits only'));
});

check('phoneText formats 10 and 11 digit numbers only', () => {
  assert.strictEqual(phoneText('+15125550100'), '(512) 555-0100');
  assert.strictEqual(phoneText('5125550100'), '(512) 555-0100');
  assert.strictEqual(phoneText('555'), null);
});

if (failures) { console.error(`\n${failures} digest render test(s) failed`); process.exit(1); }
console.log('\nall digest render tests passed');
