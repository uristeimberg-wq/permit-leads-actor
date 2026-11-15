// Street View photo check against a deployment (ADR-24, docs/IMAGERY.md).
// Signs in, opens job pages in each market, and reports what the Photos card
// did: photo shown and loaded, "no photo" with its reason, or an error from
// Google (for example a key restriction that refuses the site). Prints counts,
// tiers, statuses and Google's error text only; never the key, addresses,
// names or phones.
//
//   node test/layout/photos_check.js <base-url>   (DEMO_PASSWORD in the env)
// Exits 1 when the key is set but no photo loads on any job opened, or Google
// refuses a request.

const { chromium } = require('playwright');

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const PASSWORD = process.env.DEMO_PASSWORD || '';
const MARKETS = ['austin-tx', 'miami-dade-fl', 'miami-city-fl', 'raleigh-nc'];
const PER_MARKET = 3;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  if (PASSWORD) {
    const p = await ctx.newPage();
    await p.goto(`${BASE}/login`);
    // Email sign-in tucks the owner key into a closed <details>; open it first.
    if (await p.$('details.owner')) await p.click('details.owner summary');
    await p.fill('#pw', PASSWORD);
    await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
    await p.close();
  }
  const cfg = await (await ctx.request.get(`${BASE}/api/pilot/imagery`)).json().catch(() => null);
  console.log(`imagery config: ${cfg ? `key ${cfg.googleKey ? 'set' : 'NOT set'}` : 'endpoint missing'}`);
  if (!cfg || !cfg.googleKey) { await browser.close(); process.exit(cfg ? 0 : 1); }

  let shown = 0; let opened = 0; let refused = 0;
  for (const src of MARKETS) {
    const r = await ctx.request.get(`${BASE}/api/pilot/overview?source=${src}`);
    const jobs = r.ok() ? ((await r.json()).recent || []).map((j) => j.id).filter(Boolean).slice(0, PER_MARKET) : [];
    if (!jobs.length) console.log(`${src}: no recent jobs to open`);
    for (const id of jobs) {
      const page = await ctx.newPage();
      const google = [];
      page.on('response', async (res) => {
        const u = res.url();
        if (!u.startsWith('https://maps.googleapis.com/maps/api/streetview')) return;
        const kind = u.includes('/metadata') ? 'metadata' : 'image';
        let status = '';
        if (kind === 'metadata') {
          const j = await res.json().catch(() => ({}));
          status = j.status || '?';
          if (j.error_message) status += ` (${j.error_message})`;
          if (status.startsWith('REQUEST_DENIED')) refused += 1;
        }
        google.push(`${kind} ${res.status()}${status ? ` ${status}` : ''}`);
        if (kind === 'image' && res.status() >= 400) refused += res.status() === 403 ? 1 : 0;
      });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${BASE}/pilot/live/job.html?id=${id}&trade=electrical`, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => errors.push(e.message));
      await page.waitForTimeout(2500);
      const res = await page.evaluate(() => {
        const el = document.getElementById('photos');
        if (!el) return { card: 'absent' };
        const img = el.querySelector('figure.photo img');
        const pill = el.querySelector('figure.photo .pill');
        const none = el.querySelector('.photo-none');
        const loc = document.querySelector('.lede + p.sub');
        return {
          card: 'present',
          loaded: !!(img && img.complete && img.naturalWidth > 0),
          tier: pill ? pill.textContent.trim() : null,
          none: none ? none.textContent.replace(/^[^(]*\(|\)\.?$/g, '') : null,
          noPoint: !!(loc && /No map point/.test(loc.textContent)),
        };
      });
      opened += 1;
      if (res.loaded) shown += 1;
      console.log(`${src} job: card ${res.card}${res.loaded ? `, photo loaded, tier ${res.tier}` : ''}${res.none ? `, no photo: ${res.none}` : ''}${res.noPoint ? ', job has no map point' : ''}; google: ${google.join(', ') || 'no requests'}${errors.length ? `; page errors: ${errors.slice(0, 2).join(' | ')}` : ''}`);
      await page.close();
    }
  }
  await browser.close();
  console.log(`${shown} of ${opened} job pages showed a photo; ${refused} Google refusal(s)`);
  process.exit(refused || (opened && !shown) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
