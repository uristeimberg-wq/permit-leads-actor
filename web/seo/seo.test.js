// Offline checks for the public pages (ADR-42): rendering, escaping, the
// publish threshold, robots/sitemap/llms text, mirror hosts, referrer
// channels and crawler names. No database.
const assert = require('node:assert');
const render = require('./render.js');
const { findMarket, MARKETS } = require('./markets.js');
const { isMirrorHost, baseUrl } = require('./router.js');
const { channelOf, channelSql, crawlerOf } = require('../referrer_channels.js');

const BASE = 'https://giboro.com';
const austin = findMarket('tx', 'austin');
const miami = findMarket('FL', 'Miami');
const stats = (over = {}) => ({
  lastSyncAt: '2026-11-16T17:40:00.000Z', oldestSyncAt: '2026-11-16T17:30:00.000Z', enabled: true,
  sources: [{ slug: 'austin-tx', label: 'Austin, TX', attribution: 'City of Austin <b>Open</b> Data', endpoint: 'https://data.austintexas.gov/resource/3syk-w9eu.json', lastSyncAt: '2026-11-16T17:40:00.000Z', publicationLag: 'Austin publishes permits 2-3 days after issue' }],
  issued: { issued30: 1234, issued90: 3600, valued30: 400, valued90: 1200, value30: 98765432, value90: 300000000, from30: '2026-10-18', from90: '2026-08-19', to: '2026-11-16', latestIssue: '2026-11-14' },
  history: { records: 150000, from: '2025-10-01' },
  types: { types: [{ type: '</script><script>alert(1)</script>', issued30: 10, issued90: 30, valued90: 5, value90: 5000 }, { type: null, issued30: 1, issued90: 2, valued90: 0, value90: null }], other: null, typeCount: 2 },
  weekly: [{ weekOf: '2026-08-24', issued: null }, { weekOf: '2026-08-31', issued: 80 }],
  applications: { filed30: 300, filed90: 900, beforeIssue30: 250, beforeIssue90: 600, stages: [{ stage: 'in_review', filed30: 200, filed90: 500 }, { stage: 'bogus', filed30: 1, filed90: 1 }] },
  issuedStages: [{ stage: 'issued', issued30: 1000, issued90: 3000 }],
  applicationSources: ['Austin, TX (plan review)'],
  ...over,
});

// Markets: only the four we sync; lookups are case-insensitive and strict.
assert.deepStrictEqual(MARKETS.map((m) => `${m.state}/${m.city}`), ['tx/austin', 'fl/miami-dade', 'fl/miami', 'nc/raleigh']);
assert.strictEqual(miami.name, 'City of Miami');
assert.strictEqual(findMarket('il', 'chicago'), null);
assert.strictEqual(findMarket('tx', '../austin'), null);

// Publish threshold: no thin pages, no page without a sync.
assert.strictEqual(render.isPublishable(stats()), true);
assert.strictEqual(render.isPublishable(stats({ lastSyncAt: null })), false);
assert.strictEqual(render.isPublishable(stats({ enabled: false })), false);
assert.strictEqual(render.isPublishable(stats({ issued: { ...stats().issued, issued90: render.MIN_PERMITS_90 - 1 } })), false);

// Market page: escaped third-party text, figures, timestamps, structured data.
const html = render.marketPage(austin, stats(), BASE);
assert.ok(!html.includes('<script>alert(1)'), 'permit type escaped in HTML');
assert.ok(!html.includes('<b>Open</b>'), 'credit escaped');
const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
assert.deepStrictEqual(ld.map((x) => x['@type']).sort(), ['BreadcrumbList', 'Dataset', 'FAQPage']);
assert.ok(html.includes('records show 1,234 permits issued (all permit types)'));
assert.ok(html.includes('totalling $98,765,432'));
assert.ok(html.includes('Last updated: <time datetime="2026-11-16">2026-11-16</time>'));
assert.ok(html.includes('Type not published'));
assert.ok(html.includes('Before our history'));
assert.ok(html.includes('Stage not mapped'), 'an unknown stage is labelled, not guessed');
assert.ok(html.includes('<link rel="canonical" href="https://giboro.com/markets/tx/austin">'));
assert.ok(html.includes('href="/search?areas=a%3ATX"'));
const ds = ld.find((x) => x['@type'] === 'Dataset');
assert.strictEqual(ds.temporalCoverage, '2025-10-01/2026-11-14');
assert.strictEqual(ds.dateModified, '2026-11-16T17:40:00.000Z');
assert.ok(!/score|looking for|hiring|lead/i.test(render.keyFacts(austin, stats()).join(' ')), 'no intent or score words');

// A market with no application dates says so and shows no zero for it.
const mHtml = render.marketPage(miami, stats({ applications: null, applicationSources: [] }), BASE);
assert.ok(mHtml.includes('does not publish application dates'));
assert.ok(mHtml.includes('applications before issue: not published'));
assert.ok(!render.faqs(miami, stats({ applications: null })).some(([q]) => /applications/.test(q)));
// No value listed: no total.
const noVal = render.keyFacts(austin, stats({ issued: { ...stats().issued, valued30: 0, value30: null } }));
assert.ok(noVal.includes('None of them lists a declared value.'));

// Index, methodology, llms.txt.
const idx = render.marketsIndex([{ market: austin, stats: stats() }], BASE);
assert.ok(idx.includes('href="/markets/tx/austin"'));
const meth = render.methodologyPage([{ slug: 'austin-tx', label: 'Austin, TX', attribution: 'City of Austin', publicationLag: null, lastSyncAt: null }, { slug: 'fl-sunbiz', label: 'Sunbiz', attribution: 'x' }], BASE);
assert.ok(meth.includes('City of Austin') && !meth.includes('Sunbiz'), 'methodology lists the market sources');
const llms = render.llmsTxt(BASE, [{ market: austin, stats: stats() }]);
assert.ok(llms.startsWith('# Giboro\n\n> '));
assert.ok(llms.includes('(https://giboro.com/markets/tx/austin)'));
assert.ok(!llms.includes('Market facts'));
assert.ok(render.llmsTxt(BASE, [{ market: austin, stats: stats() }], { full: true }).includes('## Austin, TX'));

// robots.txt: every named crawler repeats the rules (a named group replaces *).
const robots = render.robotsTxt(BASE);
for (const ua of [...render.CRAWLERS, '*']) assert.ok(robots.includes(`User-agent: ${ua}\nAllow: /\nDisallow: /api/`), ua);
assert.ok(robots.endsWith('Sitemap: https://giboro.com/sitemap.xml\n'));
const sm = render.sitemapXml(BASE, [{ path: '/markets?a=1&b=2', lastmod: '2026-11-16T10:00:00Z' }]);
assert.ok(sm.includes('<loc>https://giboro.com/markets?a=1&amp;b=2</loc><lastmod>2026-11-16</lastmod>'));

// Hosts: only named mirrors are de-indexed.
assert.strictEqual(isMirrorHost('giboro.com'), false);
assert.strictEqual(isMirrorHost('www.giboro.com'), false);
assert.strictEqual(isMirrorHost('permits-production-9581a3c0.up.railway.app'), true);
assert.strictEqual(isMirrorHost('localhost'), true);
assert.strictEqual(isMirrorHost('127.0.0.1'), true);
assert.strictEqual(baseUrl({ PUBLIC_BASE_URL: 'https://giboro.com/' }), 'https://giboro.com');
assert.strictEqual(baseUrl({}), 'https://giboro.com');

// Home page and the app cookie.
const { hasAppCookie } = require('./router.js');
const home = render.homePage([{ market: austin, stats: stats() }], BASE);
assert.ok(home.includes('<link rel="canonical" href="https://giboro.com/">'));
assert.ok(home.includes('1,234 permits were issued in the last 30 days'));
assert.ok(!/subcontractor|looking for|hiring|lead score/i.test(home), 'no guesses about customers or intent');
const ck = (v) => hasAppCookie({ get: () => v });
assert.strictEqual(ck('ct_app=1'), true);
assert.strictEqual(ck('a=b; ct_app=1'), true);
assert.strictEqual(ck('ct_app=0'), false);
assert.strictEqual(ck('xct_app=1'), false);
assert.strictEqual(ck(undefined), false);

// Channels.
const ch = (referrer, utm_source) => channelOf({ referrer, utm_source });
assert.strictEqual(ch('www.google.com'), 'search');
assert.strictEqual(ch('google.co.uk'), 'search');
assert.strictEqual(ch('www.bing.com'), 'search');
assert.strictEqual(ch('duckduckgo.com'), 'search');
assert.strictEqual(ch('docs.google.com'), 'referral');
assert.strictEqual(ch('google.example.com'), 'referral');
assert.strictEqual(ch('gemini.google.com'), 'ai');
assert.strictEqual(ch('www.perplexity.ai'), 'ai');
assert.strictEqual(ch('claude.ai'), 'ai');
assert.strictEqual(ch(null, 'chatgpt.com'), 'ai');
assert.strictEqual(ch(null, 'newsletter'), 'campaign');
assert.strictEqual(ch('news.ycombinator.com'), 'referral');
assert.strictEqual(ch(null, null), 'direct');
assert.ok(!channelSql().includes("''')"));

// Crawlers.
assert.strictEqual(crawlerOf('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot'), 'OAI-SearchBot');
assert.strictEqual(crawlerOf('Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)'), 'ClaudeBot');
assert.strictEqual(crawlerOf('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'Googlebot');
assert.strictEqual(crawlerOf('Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537.36'), null);
assert.strictEqual(crawlerOf(''), null);

console.log('seo: all passed');
