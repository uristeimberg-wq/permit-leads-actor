// One-off recon: drive a real Accela ACA search and save the resulting HTML so
// selectors can be written from reality instead of guessed.
// Usage: node recon/accela_recon.js [agencyBaseUrl] [daysBack]

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE = process.argv[2] || 'https://aca-prod.accela.com/CLACKAMAS/';
const DAYS_BACK = Number(process.argv[3] || 30);
const OUT = path.join(__dirname, 'out');

const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' });

  const url = `${BASE}Cap/CapHome.aspx?module=Building&TabName=Home`;
  console.log('Opening', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const end = new Date();
  const start = new Date(end.getTime() - DAYS_BACK * 86400000);

  const startSel = '#ctl00_PlaceHolderMain_generalSearchForm_txtGSStartDate';
  const endSel = '#ctl00_PlaceHolderMain_generalSearchForm_txtGSEndDate';
  await page.waitForSelector(startSel, { timeout: 30000 });
  // These are ASP.NET MaskedEdit fields: they track a ClientState updated by
  // key events, so a plain fill() leaves them looking empty to validation.
  await page.click(startSel);
  await page.type(startSel, fmt(start), { delay: 60 });
  await page.keyboard.press('Tab');
  await page.click(endSel);
  await page.type(endSel, fmt(end), { delay: 60 });
  await page.keyboard.press('Tab');
  console.log(`Date range: ${fmt(start)} -> ${fmt(end)}`);

  await page.click('#ctl00_PlaceHolderMain_btnNewSearch');
  // ACA posts back into an UpdatePanel; wait for network to settle.
  await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const html = await page.content();
  fs.writeFileSync(path.join(OUT, 'accela_results.html'), html);
  if (page.url().includes('Error.aspx')) {
    const msg = await page.locator('body').innerText().catch(() => '');
    console.log('\n=== ERROR PAGE TEXT ===\n' + msg.slice(0, 1200));
  }
  await page.screenshot({ path: path.join(OUT, 'accela_results.png'), fullPage: true });
  console.log('URL after search:', page.url());

  // What tables exist, and what are their headers?
  const tables = await page.$$eval('table', (ts) =>
    ts.map((t) => ({
      id: t.id,
      rows: t.rows.length,
      headers: [...t.querySelectorAll('th')].map((h) => h.innerText.trim()).filter(Boolean),
    })).filter((t) => t.headers.length > 0 || t.rows > 3),
  );
  console.log('\n=== TABLES ===');
  console.log(JSON.stringify(tables, null, 2).slice(0, 3000));

  await browser.close();
})().catch((e) => { console.error('RECON FAILED:', e.message); process.exit(1); });
