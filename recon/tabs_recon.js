// One-off recon: the Fees and Inspections tabs are lazily AJAX-loaded
// ("Fees Loading... Inspections Loading..."), so their markup is NOT in the
// detail HTML we already fetch. Click them on a real permit, save what comes
// back, and only then write parsers.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const URL = process.argv[2]
  || 'https://aca-prod.accela.com/CLACKAMAS/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=011D4&agencyCode=CLACKAMAS&IsToShowInspection=';
const OUT = path.join(__dirname, 'out');

(async () => {
  const b = await chromium.launch();
  // Wide viewport: the tab bar collapses overflow tabs into a "More..." menu at
  // narrower widths, which hides Fees entirely.
  const p = await b.newPage({
    viewport: { width: 1700, height: 1000 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(3000);

  for (const [name, selector] of [['fee', 'a[href="#tab-fee"]'], ['inspections', 'a[href="#tab-inspections"]']]) {
    const link = p.locator(selector).first();
    if (await link.count() === 0) { console.log(`${name}: tab link not found`); continue; }
    // These tabs use onclick="return false" plus a data-control handler, and may
    // still be hidden behind the overflow menu, so dispatch the click directly.
    await p.evaluate((sel) => document.querySelector(sel)?.click(), selector);
    // Wait for the "Loading..." placeholder to be replaced.
    await p.waitForFunction(
      (id) => {
        const el = document.querySelector(id);
        return el && !/Loading\.\.\./.test(el.innerText);
      },
      `#tab-${name === 'fee' ? 'fee' : 'inspections'}`,
      { timeout: 30000 },
    ).catch(() => console.log(`  ${name}: still showing Loading after 30s`));
    await p.waitForTimeout(1500);

    const panel = await p.locator(`#tab-${name === 'fee' ? 'fee' : 'inspections'}`).innerHTML().catch(() => '');
    fs.writeFileSync(path.join(OUT, `accela_tab_${name}.html`), panel);
    const text = await p.locator(`#tab-${name === 'fee' ? 'fee' : 'inspections'}`).innerText().catch(() => '');
    console.log(`\n===== ${name.toUpperCase()} TAB (${panel.length} bytes) =====`);
    console.log(text.replace(/\n{2,}/g, '\n').slice(0, 900));
  }
  await b.close();
})().catch((e) => { console.error('RECON FAILED:', e.message); process.exit(1); });
