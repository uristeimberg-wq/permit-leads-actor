const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'https://aca-prod.accela.com/CLACKAMAS/';
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
  console.log('search ok');

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('a[href*="btnExport"]'),
  ]);
  const out = path.join(__dirname, 'out', 'accela_export.csv');
  await download.saveAs(out);
  console.log('DOWNLOADED ->', download.suggestedFilename(), fs.statSync(out).size, 'bytes');
  await browser.close();
})().catch((err) => { console.error('EXPORT FAILED:', err.message); process.exit(1); });
