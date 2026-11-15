// Offline checks for the guided tour (tour.js): when it opens by itself,
// resume handling, storage that throws, and the copy rules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./tour.js');

const store = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };

// Opens by itself only on the overview, once.
assert.equal(T.shouldAutoOpen({ local: store(), page: 'index.html', search: '' }), true);
assert.equal(T.shouldAutoOpen({ local: store({ [T.KEY]: 'done' }), page: 'index.html', search: '' }), false);
assert.equal(T.shouldAutoOpen({ local: store(), page: 'early.html', search: '' }), false);
// ?tour=1 forces it anywhere; ?tour=0 suppresses it (screenshots, demos).
assert.equal(T.shouldAutoOpen({ local: store({ [T.KEY]: 'done' }), page: 'gcs.html', search: '?tour=1' }), true);
assert.equal(T.shouldAutoOpen({ local: store(), page: 'index.html', search: '?source=raleigh-nc&tour=0' }), false);
assert.equal(T.shouldAutoOpen({ local: store(), page: 'index.html', search: '?tour=10' }), true, 'tour=10 is not tour=1 or tour=0');
// Storage that throws (private window) or is missing never breaks the page.
assert.equal(T.shouldAutoOpen({ local: broken, page: 'index.html', search: '' }), true);
assert.equal(T.shouldAutoOpen({ local: null, page: 'index.html', search: '' }), true);
assert.doesNotThrow(() => { T.set(broken, 'k', 'v'); T.del(broken, 'k'); });

// Resume step: only a valid index.
assert.equal(T.resumeStep(store({ [T.RESUME]: '2' })), 2);
assert.equal(T.resumeStep(store({ [T.RESUME]: String(T.STEPS.length) })), -1);
assert.equal(T.resumeStep(store({ [T.RESUME]: 'x' })), -1);
assert.equal(T.resumeStep(store()), -1);
assert.equal(T.resumeStep(broken), -1);

// Steps: every one has a title and body; links point at screens that exist.
const live = __dirname;
const pub = path.join(__dirname, '..', '..');
for (const s of T.STEPS) {
  assert.ok(s.title && Array.isArray(s.body) && s.body.length, `step ${s.title} has copy`);
  if (s.href) {
    const file = s.href.startsWith('/') ? path.join(pub, s.href === '/search.html' ? 'index.html' : s.href) : path.join(live, s.href);
    assert.ok(fs.existsSync(file), `step ${s.title} links to ${s.href}`);
  }
  // Copy is static and inserted as HTML: keep markup characters out of it.
  for (const t of [s.title, s.cta || '', ...s.body]) assert.ok(!/[<>&]/.test(t), `step ${s.title}: no markup characters`);
}

// Features the tour must cover.
const all = T.STEPS.map((s) => `${s.title} ${s.body.join(' ')}`).join(' ').toLowerCase();
for (const k of ['early filings', 'filed by', 'tap one to call', 'builder activity', 'gc relationships',
  'appraiser', 'licence', 'permit search', 'austin', 'miami-dade', 'city of miami', 'raleigh']) {
  assert.ok(all.includes(k), `tour covers "${k}"`);
}
// Wording rules (docs/PILOT_UX.md, docs/DATA_TRUST_AUDIT.md): no estimates are
// shown, so the tour says so; a missing trade permit is never presented as
// "not hired" or "you're first", and no screen claims a GC is looking for a sub.
assert.ok(/do not show estimates/.test(all));
assert.ok(!/likely issued|rising or new|hire new subs|who to call/.test(all), 'no inferred features described');
assert.ok(!/you'?re first|be the first|guaranteed/.test(all), 'no overclaiming');
assert.ok(!/\bnot hired\b/.test(all.replace('does not mean a sub has not been hired', '')), 'only the disclaimer may mention hiring');

// Every live (pilot) screen loads the tour. The Leads screen (index.html, the
// front door since redesign step 1) deliberately does not: the tour describes
// the pilot screens, which Leads no longer links to.
for (const f of fs.readdirSync(live).filter((n) => n.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(live, f), 'utf8');
  assert.ok(html.includes('src="tour.js"') && html.includes('href="tour.css"'), `${f} loads the tour`);
}
const search = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
assert.ok(!search.includes('tour.js') && !search.includes('data-tour-open'), 'Leads screen does not load the tour');

console.log('tour.test.js: all passed');
