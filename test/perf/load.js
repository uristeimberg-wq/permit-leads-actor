// Load-time measurement of a deployment: what a user waits for when they open
// the app. Signs in, then times
//   1. each API the screens call, twice in a row (first vs. repeat), with the
//      bytes on the wire and whether the response was compressed;
//   2. the overview screen in a real browser on a desktop and on a phone with
//      a throttled 4G-like network, to the moment the headline number appears;
//   3. optionally (COLD_WAIT_S), the same overview API after the database has
//      been idle long enough for Neon Free to suspend its compute.
// Prints timings and sizes only, never names or phones.
//
//   node test/perf/load.js <base-url>   (DEMO_PASSWORD in the env when the gate is on)

const { chromium, devices } = require('playwright');

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const PASSWORD = process.env.DEMO_PASSWORD || '';
const COLD_WAIT_S = Number(process.env.COLD_WAIT_S || 0);
const ROUNDS = Number(process.env.ROUNDS || 2);

const API = [
  '/api/pilot/overview?source=austin-tx',
  '/api/pilot/overview?source=miami-dade-fl',
  '/api/pilot/overview?source=miami-city-fl',
  '/api/pilot/overview?source=raleigh-nc',
  '/api/pilot/meta?source=austin-tx',
  '/api/pilot/gcs?source=austin-tx&trade=electrical&months=12',
  '/api/pilot/leads?source=austin-tx&trade=electrical&days=7',
  '/api/pilot/early?source=austin-tx&days=30',
];
const STATIC = ['/pilot/live/', '/pilot/live/live.js', '/pilot/live/overview.js', '/pilot/live/live.css'];

const ms = (t) => `${Math.round(t)} ms`;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function cookie() {
  if (!PASSWORD) return '';
  const r = await fetch(`${BASE}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: PASSWORD, next: '/' }),
  });
  const set = r.headers.get('set-cookie') || '';
  if (r.status !== 303 || !set) throw new Error(`sign-in failed (${r.status})`);
  return set.split(';')[0];
}

/** One timed GET. Wire bytes come from content-length when the body is compressed. */
async function timed(path, jar) {
  const t0 = performance.now();
  const r = await fetch(`${BASE}${path}`, { headers: { cookie: jar, 'accept-encoding': 'gzip, br' } });
  const ttfb = performance.now() - t0;
  const body = await r.arrayBuffer();
  const total = performance.now() - t0;
  return {
    path, status: r.status, ttfb, total,
    bytes: body.byteLength,
    encoding: r.headers.get('content-encoding') || 'none',
    cache: r.headers.get('cache-control') || '-',
    xCache: r.headers.get('x-cache') || '-',
  };
}

function print(rows) {
  for (const r of rows) {
    console.log(`${String(r.status).padEnd(4)} ${ms(r.total).padStart(9)} (ttfb ${ms(r.ttfb).padStart(8)}) ${kb(r.bytes).padStart(9)} enc=${r.encoding} cache=${r.cache} x-cache=${r.xCache}  ${r.path}`);
  }
}

async function browserRun(name, ctxOpts, throttle) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(ctxOpts);
  if (PASSWORD) {
    const [k, v] = (await cookie()).split('=');
    const u = new URL(BASE);
    await ctx.addCookies([{ name: k, value: v, domain: u.hostname, path: '/', secure: u.protocol === 'https:', httpOnly: true, sameSite: 'Lax' }]);
  }
  const results = [];
  for (const [label, path] of [['overview austin', '/pilot/live/'], ['overview raleigh', '/pilot/live/?source=raleigh-nc'], ['gcs austin', '/pilot/live/gcs.html']]) {
    for (let i = 0; i < ROUNDS; i += 1) {
      const page = await ctx.newPage();
      if (throttle) {
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Network.emulateNetworkConditions', throttle);
      }
      const t0 = Date.now();
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
      const dcl = Date.now() - t0;
      // Data is on screen when the first skeleton placeholder is gone.
      const sel = path.includes('gcs') ? '#list .state, #list table, #list .gc, main table' : '#hero-fig b:not(.skel)';
      let dataAt = null;
      try { await page.waitForSelector(sel, { timeout: 120000 }); dataAt = Date.now() - t0; } catch { /* reported as null */ }
      results.push({ label: `${label} #${i + 1}`, dcl, dataAt });
      await page.close();
    }
  }
  await browser.close();
  console.log(`\n== browser: ${name}`);
  for (const r of results) console.log(`${r.label.padEnd(22)} html ready ${ms(r.dcl).padStart(9)}   data on screen ${r.dataAt == null ? 'never (timeout)' : ms(r.dataAt).padStart(9)}`);
}

(async () => {
  const jar = await cookie();
  console.log(`== ${BASE} ${new Date().toISOString()}`);
  for (let round = 1; round <= ROUNDS; round += 1) {
    console.log(`\n== API round ${round} (sequential)`);
    const rows = [];
    for (const p of [...STATIC, ...API]) rows.push(await timed(p, jar));
    print(rows);
  }

  // Desktop on a fast line; phone on a throttled mobile line (CDP: ~9 Mbit/s down, 150 ms RTT).
  await browserRun('desktop 1280x800', { viewport: { width: 1280, height: 800 } }, null);
  await browserRun('phone (iPhone 13, 4G-like)', { ...devices['iPhone 13'] }, {
    offline: false, latency: 150, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8,
  });

  if (COLD_WAIT_S > 0) {
    console.log(`\n== cold start: waiting ${COLD_WAIT_S}s with no requests so the database can suspend`);
    await new Promise((r) => setTimeout(r, COLD_WAIT_S * 1000));
    print([await timed('/api/pilot/overview?source=austin-tx', jar), await timed('/api/pilot/overview?source=austin-tx', jar)]);
  }
})().catch((err) => { console.error(err.message); process.exit(1); });
