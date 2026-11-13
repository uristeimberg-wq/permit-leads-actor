const fs=require('node:fs'); const {chromium}=require('playwright');
(async()=>{
  const b=await chromium.launch();
  const p=await b.newPage({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'});
  await p.goto('https://aca-prod.accela.com/CLACKAMAS/Cap/CapHome.aspx?module=Building&TabName=Home',{waitUntil:'domcontentloaded',timeout:60000});
  await p.waitForTimeout(5000);
  console.log('url:', p.url());
  console.log('title:', await p.title());
  fs.writeFileSync('recon/out/diagnose.html', await p.content());
  const txt=(await p.locator('body').innerText().catch(()=>'')).replace(/\n{2,}/g,'\n');
  console.log('--- body text (700) ---\n'+txt.slice(0,700));
  console.log('--- start-date field present?', await p.locator('#ctl00_PlaceHolderMain_generalSearchForm_txtGSStartDate').count());
  console.log('--- hidden but in DOM?', await p.locator('#ctl00_PlaceHolderMain_generalSearchForm_txtGSStartDate').isVisible().catch(()=>'n/a'));
  await b.close();
})();
