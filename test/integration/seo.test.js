// Integration: the public pages for search and AI crawlers (ADR-42) against a
// real database, through the real server with the login gate ON
// (REQUIRE_LOGIN=1), so a page that fell behind the gate would fail here.
// Checks: 200 without a redirect to /login, valid JSON-LD, counts equal to
// SQL, no record-level data or secrets in the HTML, thin markets 404 and stay
// out of the sitemap, canonical-host indexing, the crawler count, and the
// search/AI channels on the owner's dashboard.
// Needs Postgres (DATABASE_URL; default :5433). Uses a throwaway database.

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_seo_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();
const OWNER = 'owner-seo-key';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// Record-level values that must never reach a public page.
const SECRETS = ['Sample Secret Builders LLC', '5125550199', 'Jane Q Homeowner', '777 HIDDEN LN', 'PN-SECRET-', 'remodel the hidden kitchen', OWNER, 'demo_session'];

const uuid = (a, n) => `${a.repeat(8)}-${a.repeat(4)}-4${a.repeat(3)}-8${a.repeat(3)}-${String(n).padStart(12, '0')}`;

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  Object.assign(process.env, { DATABASE_URL: testUrl, DEMO_PASSWORD: OWNER, SESSION_SECRET: 'seo-test', REQUIRE_LOGIN: '1', API_CACHE: 'off', PUBLIC_BASE_URL: 'https://giboro.com' });
  const db = require('../../db/index.js');
  const { app } = require('../../web/server.js');
  let server;
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  try {
    await db.applySchema();
    // 80 Austin permits over 80 days: two types, every third with a value,
    // and record-level values that must stay off the public pages.
    await db.query(`
      INSERT INTO permits (source_area, permit_number, address, city, state, zip, permit_type, work_description, valuation,
                           filed_date, owner, contractor_name, contractor_phone, status_raw, status_stage, lifecycle_stage)
      SELECT 'austin-tx', 'PN-SECRET-' || g, '777 HIDDEN LN', 'AUSTIN', 'TX', '78704',
             CASE WHEN g % 2 = 0 THEN 'Building Permit' ELSE 'Electrical Permit' END, 'remodel the hidden kitchen',
             CASE WHEN g % 3 = 0 THEN 10000 + g END, current_date - g, 'Jane Q Homeowner', 'Sample Secret Builders LLC', '5125550199',
             'Active', 'approved', CASE WHEN g % 4 = 0 THEN 'completed' ELSE 'issued' END
        FROM generate_series(0, 79) g`);
    // Plan-review cases (applications before issue), 10 in the last 30 days.
    await db.query(`
      INSERT INTO permits (source_area, permit_number, permit_type, filed_date, filing_kind, lifecycle_stage, status_stage)
      SELECT 'austin-plan-review-tx', 'PR-' || g, 'R- 101 Single Family Houses', current_date - g * 3, 'building_application',
             CASE WHEN g < 4 THEN 'in_review' ELSE 'issued' END, 'pending'
        FROM generate_series(0, 9) g`);
    // City of Miami: 5 permits, below the page threshold.
    await db.query(`
      INSERT INTO permits (source_area, permit_number, permit_type, filed_date, lifecycle_stage)
      SELECT 'miami-city-fl', 'CM-' || g, 'Building', current_date - g, 'issued' FROM generate_series(1, 5) g`);
    for (const slug of ['austin-tx', 'austin-plan-review-tx', 'miami-city-fl']) {
      await db.query(`INSERT INTO sync_runs (source_id, kind, status, started_at, finished_at)
                      SELECT id, 'scheduled', 'succeeded', now() - interval '1 hour', now() - interval '50 minutes' FROM sources WHERE slug = $1`, [slug]);
    }

    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p, headers = {}) => {
      const r = await fetch(base + p, { headers: { 'user-agent': CHROME, ...headers }, redirect: 'manual' });
      return { status: r.status, headers: r.headers, body: await r.text() };
    };
    const ldOf = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

    const austin = await get('/markets/tx/austin');

    await check('public pages answer 200 with the login gate on, no redirect to /login', async () => {
      for (const p of ['/markets', '/markets/tx/austin', '/data-methodology', '/robots.txt', '/sitemap.xml', '/llms.txt', '/llms-full.txt']) {
        const r = await get(p);
        assert.strictEqual(r.status, 200, `${p} -> ${r.status} ${r.headers.get('location') || ''}`);
        assert.ok(!/\/login/.test(r.headers.get('location') || ''), p);
      }
      // The app itself stays behind the gate: /search, / with a query string,
      // and / for a browser that has opened the app (ct_app=1).
      for (const [p, h] of [['/search', {}], ['/?areas=a:TX', {}], ['/', { cookie: 'x=1; ct_app=1' }]]) {
        const r = await get(p, h);
        assert.strictEqual(r.status, 302, p);
        assert.match(r.headers.get('location'), /^\/login/, p);
      }
    });

    await check('a first-time visitor and crawlers get the home page at /', async () => {
      const home = await get('/', { 'user-agent': GOOGLEBOT });
      assert.strictEqual(home.status, 200);
      assert.match(home.headers.get('vary'), /Cookie/);
      assert.match(home.body, /<link rel="canonical" href="https:\/\/giboro.com\/">/);
      assert.ok(home.body.includes('href="/markets/tx/austin"'));
      assert.ok(home.body.includes('href="/search"'));
      assert.ok(home.body.includes('<b>30</b> permits issued, last 30 days'));
      const types = ldOf(home.body).map((x) => x['@type']).sort();
      assert.deepStrictEqual(types, ['Organization', 'WebSite']);
      for (const x of SECRETS) assert.ok(!home.body.includes(x), x);
      assert.ok((await get('/sitemap.xml')).body.includes('<loc>https://giboro.com/</loc>'));
    });

    await check('market page is server-rendered with valid JSON-LD (Dataset, BreadcrumbList, FAQPage)', async () => {
      const ld = ldOf(austin.body);
      const types = ld.map((x) => x['@type']).sort();
      assert.deepStrictEqual(types, ['BreadcrumbList', 'Dataset', 'FAQPage']);
      const ds = ld.find((x) => x['@type'] === 'Dataset');
      assert.strictEqual(ds.url, 'https://giboro.com/markets/tx/austin');
      assert.ok(ds.dateModified && ds.spatialCoverage && ds.variableMeasured.length >= 3);
      const faq = ld.find((x) => x['@type'] === 'FAQPage');
      // Every FAQ answer is also visible on the page.
      for (const q of faq.mainEntity) assert.ok(austin.body.includes(q.acceptedAnswer.text.replace(/'/g, '&#39;')), q.name);
      assert.match(austin.body, /<link rel="canonical" href="https:\/\/giboro.com\/markets\/tx\/austin">/);
      assert.match(austin.body, /<meta name="description" content="[^"]{40,}">/);
      assert.match(austin.body, /<meta property="og:title"/);
      assert.match(austin.body, /Last updated: <time datetime="\d{4}-\d{2}-\d{2}">/);
      for (const p of ['/markets', '/data-methodology']) for (const x of ldOf((await get(p)).body)) assert.ok(x['@type'], p);
    });

    await check('counts on the page equal SQL', async () => {
      const { rows: [c] } = await db.query(`SELECT count(*) FILTER (WHERE filed_date > current_date - 30)::int AS i30, count(*) FILTER (WHERE filed_date > current_date - 90)::int AS i90,
        sum(valuation) FILTER (WHERE filed_date > current_date - 30)::bigint AS v30 FROM permits WHERE source_area = 'austin-tx'`);
      assert.strictEqual(c.i30, 30);
      assert.ok(austin.body.includes(`records show ${c.i30} permits issued`), 'issued 30');
      assert.ok(austin.body.includes(`<b>${c.i90}</b><span>permits issued, last 90 days`), 'issued 90');
      assert.ok(austin.body.includes(`totalling $${Number(c.v30).toLocaleString('en-US')}`), 'value 30');
      assert.ok(austin.body.includes('10 applications were filed before issue') || austin.body.includes('applications were filed before issue'), 'applications');
      assert.ok(austin.body.includes('<td>Electrical Permit</td>'), 'source permit type shown as published');
    });

    await check('no record-level data, contacts or secrets in any public response', async () => {
      for (const p of ['/markets', '/markets/tx/austin', '/data-methodology', '/robots.txt', '/sitemap.xml', '/llms.txt', '/llms-full.txt']) {
        const r = await get(p);
        for (const s of SECRETS) assert.ok(!r.body.includes(s), `${p} leaks ${s}`);
        assert.ok(!/set-cookie/i.test([...r.headers.keys()].join(',')), `${p} sets a cookie`);
      }
    });

    await check('thin or uncovered markets 404 and stay out of the sitemap', async () => {
      assert.strictEqual((await get('/markets/fl/miami')).status, 404);
      assert.strictEqual((await get('/markets/il/chicago')).status, 404);
      assert.strictEqual((await get('/markets/nc/raleigh')).status, 404);
      const sm = (await get('/sitemap.xml')).body;
      assert.match(sm, /<loc>https:\/\/giboro.com\/markets\/tx\/austin<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
      assert.ok(!sm.includes('/markets/fl/miami'));
      assert.ok(!(await get('/llms.txt')).body.includes('/markets/fl/miami)'));
      const r = await get('/markets/TX/Austin/');
      assert.strictEqual(r.status, 301);
      assert.strictEqual(r.headers.get('location'), '/markets/tx/austin');
    });

    await check('robots.txt allows the public pages, names AI crawlers, blocks APIs and admin', async () => {
      const t = (await get('/robots.txt')).body;
      for (const ua of ['Googlebot', 'Bingbot', 'OAI-SearchBot', 'PerplexityBot', 'ClaudeBot', 'Applebot']) assert.ok(t.includes(`User-agent: ${ua}\nAllow: /\n`), ua);
      assert.match(t, /Disallow: \/api\//);
      assert.match(t, /Disallow: \/admin/);
      assert.match(t, /Sitemap: https:\/\/giboro.com\/sitemap.xml/);
    });

    await check('a mirror host sends noindex; the canonical link names giboro.com', async () => {
      // 127.0.0.1 stands in for the railway.app mirror (web/seo/router.js isMirrorHost).
      assert.match(austin.headers.get('x-robots-tag'), /noindex/);
      assert.match(austin.body, /<link rel="canonical" href="https:\/\/giboro.com\/markets\/tx\/austin">/);
      assert.match(austin.headers.get('cache-control'), /public/);
      const etag = austin.headers.get('etag');
      assert.strictEqual((await get('/markets/tx/austin', { 'if-none-match': etag })).status, 304);
    });

    await check('crawler requests are counted per route, not per raw URL', async () => {
      await get('/markets/tx/austin?utm=x', { 'user-agent': GOOGLEBOT });
      await get('/llms.txt', { 'user-agent': 'Mozilla/5.0 (compatible; PerplexityBot/1.0)' });
      await new Promise((r) => setTimeout(r, 200));
      const { rows } = await db.query('SELECT crawler, path, hits FROM crawler_visits ORDER BY crawler, path');
      assert.deepStrictEqual(rows.map((r) => `${r.crawler} ${r.path}`), ['Googlebot /', 'Googlebot /markets/tx/austin', 'PerplexityBot /llms.txt']);
    });

    await check('dashboard shows search-engine and AI-assistant visits', async () => {
      // Sessions as the tracker writes them (web/telemetry.js), one page view each.
      const visit = async (n, entry, referrer, utm) => {
        await db.query(`INSERT INTO analytics_sessions (session_id, anonymous_device_id, started_at, last_active_at, entry_path, referrer, utm_source)
                        VALUES ($1, $2, now(), now(), $3, $4, $5)`, [uuid('a', n), uuid('d', n), entry, referrer, utm]);
        await db.query(`INSERT INTO analytics_events (event_id, session_id, anonymous_device_id, event_name, event_category, page_path, client_timestamp)
                        VALUES ($1, $2, $3, 'page_view', 'navigation', $4, now())`, [uuid('c', n), uuid('a', n), uuid('d', n), entry]);
      };
      await visit(1, '/markets/tx/austin', 'www.google.com', null);
      await visit(2, '/', null, 'chatgpt.com');
      await visit(3, '/', 'www.perplexity.ai', null);
      await visit(4, '/', null, null);
      const r = await fetch(`${base}/api/admin/analytics/charts?days=7`, { headers: { authorization: `Basic ${Buffer.from(`x:${OWNER}`).toString('base64')}` } });
      assert.strictEqual(r.status, 200);
      const d = await r.json();
      const by = Object.fromEntries(d.channels.map((c) => [c.channel, c]));
      assert.strictEqual(by.search.sessions, 1);
      assert.strictEqual(by.search.landedPublic, 1);
      assert.strictEqual(by.ai.sessions, 2);
      assert.strictEqual(by.direct.sessions, 1);
      assert.ok(d.crawlers.some((c) => c.crawler === 'Googlebot'));
    });
  } finally {
    if (server) server.close();
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  }
  if (failures) { console.error(`${failures} failed`); process.exit(1); }
  console.log('seo integration: all passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
