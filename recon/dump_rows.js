const fs = require('node:fs');
const { chromium } = require('playwright');
const html = fs.readFileSync('recon/out/accela_results.html', 'utf8');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.setContent(html);
  const rows = await p.$$eval('#ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList tr', (trs) =>
    trs.map((tr) => [...tr.querySelectorAll('td,th')].map((c) => c.innerText.replace(/\s+/g, ' ').trim())),
  );
  rows.slice(0, 9).forEach((r, i) => console.log(i, JSON.stringify(r)));
  console.log('\ntotal rows:', rows.length);
  // link shape for detail pages
  const links = await p.$$eval('#ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList a[href]', (as) =>
    as.slice(0, 3).map((a) => ({ text: a.innerText.trim(), href: a.getAttribute('href') })));
  console.log('\nlinks:', JSON.stringify(links, null, 2));
  await b.close();
})();
