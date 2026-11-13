const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const BASE = 'https://aca-prod.accela.com/CLACKAMAS/';
const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}Cap/CapHome.aspx?module=Building&TabName=Home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const end = new Date(), start = new Date(Date.now() - 14 * 86400000);
  const s = '#ctl00_PlaceHolderMain_generalSearchForm_txtGSStartDate';
  const e = '#ctl00_PlaceHolderMain_generalSearchForm_txtGSEndDate';
  await page.waitForSelector(s, { timeout: 30000 });
  await page.click(s); await page.type(s, fmt(start), { delay: 60 }); await page.keyboard.press('Tab');
  await page.click(e); await page.type(e, fmt(end), { delay: 60 }); await page.keyboard.press('Tab');
  await page.click('#ctl00_PlaceHolderMain_btnNewSearch');
  await page.waitForSelector('#ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList', { timeout: 90000 });

  // sniff what the export postback actually responds with
  page.on('response', (r) => {
    const ct = r.headers()['content-type'] || '';
    if (/csv|excel|octet-stream|spreadsheet/i.test(ct)) console.log('EXPORT-ISH RESPONSE:', r.status(), ct, r.url().slice(0, 120));
  });

  // open the first permit detail page
  const link = page.locator('#ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList a[href*="CapDetail"], #ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList td a').filter({ hasText: /^[A-Z]\d{6,}/ }).first();
  const permitNo = (await link.innerText().catch(() => '')).trim();
  console.log('opening detail for:', permitNo);
  await link.click();
  await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(3000);
  console.log('detail url:', page.url().slice(0, 140));
  fs.writeFileSync(path.join(__dirname, 'out', 'accela_detail.html'), await page.content());

  const text = await page.locator('body').innerText();
  console.log('\n=== DETAIL TEXT (first 2500 chars) ===\n' + text.replace(/\n{2,}/g, '\n').slice(0, 2500));
  await browser.close();
})().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
