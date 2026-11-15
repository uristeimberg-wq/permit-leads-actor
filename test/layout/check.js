// Phone and tablet layout check (Playwright). Signs in, opens every screen at
// phone and tablet widths, and fails on:
//   - horizontal page scroll (content wider than the viewport)
//   - a nav link, button or form control under 44px tall on a touch screen
//     (inline text buttons such as company names in search results excepted)
//   - a JavaScript error on the page
// Saves a full-page screenshot of each screen to OUT (default layout-shots/).
// Prints counts and sizes only, never names or phones.
//
//   node test/layout/check.js <base-url>   (DEMO_PASSWORD in the env when the gate is on)

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const PASSWORD = process.env.DEMO_PASSWORD || '';
const OUT = process.env.OUT || 'layout-shots';
const VIEWPORTS = [
  { name: 'phone-375', width: 375, height: 812 },
  { name: 'phone-414', width: 414, height: 896 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'tablet-1024', width: 1024, height: 1366 },
];
const MIN_TARGET = 44;

async function signIn(ctx) {
  if (!PASSWORD) return;
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  // Email sign-in tucks the owner key into a closed <details>; open it first.
  if (await page.$('details.owner')) await page.click('details.owner summary');
  await page.fill('#pw', PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
  await page.close();
}

/** A job and a contractor to open, taken from the overview API. */
async function pickIds(ctx) {
  const r = await ctx.request.get(`${BASE}/api/pilot/overview?source=austin-tx`);
  if (!r.ok()) return {};
  const d = await r.json();
  const job = (d.recent || [])[0];
  const gc = (d.topGcs || []).map((g) => g.gc).find((g) => g && g.id && g.name);
  return { job: job && job.id, gc: gc && gc.id };
}

function measure(minTarget) {
  const vw = document.documentElement.clientWidth;
  const small = [];
  const selector = '.nav a, .signout, button:not(.link-btn), select, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), .btn, .leaflet-bar a';
  for (const el of document.querySelectorAll(selector)) {
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height || getComputedStyle(el).visibility === 'hidden') continue;
    if (b.height < minTarget - 0.5) small.push(`${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).trim().split(/\s+/).join('.')}` : ''} ${Math.round(b.width)}x${Math.round(b.height)}`);
  }
  return { scrollWidth: document.documentElement.scrollWidth, viewport: vw, small: [...new Set(small)] };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  let failures = 0;
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: true, isMobile: true });
    await signIn(ctx);
    const ids = await pickIds(ctx);
    const pages = [
      ['login', '/login'],
      ['overview', '/pilot/live/'],
      ['early', '/pilot/live/early.html'],
      ['early-raleigh', '/pilot/live/early.html?source=raleigh-nc'],
      ['momentum', '/pilot/live/momentum.html?segment=all&tab=all'],
      ['gcs', '/pilot/live/gcs.html'],
      ['digest', '/pilot/live/digest.html'],
      // The customer email (ADR-20), rendered from the same data, and its preview index.
      ['digest-email', '/digest/sample?source=austin-tx&trades=electrical,plumbing&early=homes&days=30'],
      ['digest-previews', '/digest/preview'],
      ...(ids.job ? [['job', `/pilot/live/job.html?id=${ids.job}&trade=electrical`]] : []),
      ...(ids.gc ? [['contractor', `/pilot/live/contractor.html?id=${ids.gc}`]] : []),
      ['search', '/search.html'],
      ['privacy', '/privacy'],
      // Owner only (ADR-37): the layout run signs in with the owner key.
      ['admin-analytics', '/admin/analytics'],
    ];
    if (!ids.job || !ids.gc) console.log(`${vp.name}: no ${ids.job ? '' : 'job '}${ids.gc ? '' : 'contractor '}to open (empty data?)`);
    for (const [name, url] of pages) {
      // The sign-in page is checked signed out, as a visitor sees it.
      const page = name === 'login' ? await (await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: true, isMobile: true })).newPage() : await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => errors.push(`load: ${e.message}`));
      await page.waitForTimeout(500);
      const m = await page.evaluate(measure, MIN_TARGET);
      await page.screenshot({ path: path.join(OUT, `${vp.name}-${name}.png`), fullPage: true });
      const problems = [];
      if (m.scrollWidth > m.viewport) problems.push(`page is ${m.scrollWidth}px wide in a ${m.viewport}px viewport`);
      if (m.small.length) problems.push(`controls under ${MIN_TARGET}px: ${m.small.slice(0, 6).join(', ')}`);
      if (errors.length) problems.push(`errors: ${errors.slice(0, 3).join(' | ')}`);
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${vp.name} ${name}${problems.length ? `: ${problems.join('; ')}` : ''}`);
      failures += problems.length ? 1 : 0;
      await page.close();
    }
    await ctx.close();
  }
  await browser.close();
  console.log(failures ? `${failures} screen(s) failed` : 'all screens fit phones and tablets');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
