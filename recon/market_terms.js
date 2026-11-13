// Market scan, part 3: the licence and terms attached to each candidate source.
//
// Read-only research. For ArcGIS layers: the layer's copyrightText, its
// service item (serviceItemId) and that item's licenseInfo / accessInformation
// on ArcGIS Online. For Socrata datasets: the licence and attribution in the
// dataset metadata. Prints the text so a person can read it; it decides nothing.
//
//   node recon/market_terms.js --only=arcgis:<layer url>,socrata:<domain>/<id>
// CI: .github/workflows/feasibility.yml, input `market_terms`.

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.indexOf('=');
  return i < 0 ? [a.replace(/^--/, ''), true] : [a.slice(2, i), a.slice(i + 1)];
}));
const UA = 'permit-leads-market-scan/0.1 (research; read-only)';
const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

async function arcgis(url) {
  const layer = await get(`${url}?f=json`);
  const svcUrl = url.replace(/\/\d+$/, '');
  const svc = await get(`${svcUrl}?f=json`).catch(() => ({}));
  const id = layer.serviceItemId || svc.serviceItemId;
  const out = { url, layer: layer.name, copyrightText: strip(layer.copyrightText || svc.copyrightText), serviceItemId: id };
  if (id) {
    const item = await get(`https://www.arcgis.com/sharing/rest/content/items/${id}?f=json`).catch((e) => ({ error: e.message }));
    Object.assign(out, { itemTitle: item.title, owner: item.owner, licenseInfo: strip(item.licenseInfo), accessInformation: strip(item.accessInformation), itemError: item.error, modified: item.modified ? new Date(item.modified).toISOString().slice(0, 10) : null });
  }
  return out;
}

async function socrata(spec) {
  const [domain, id] = spec.split('/');
  const m = await get(`https://${domain}/api/views/${id}.json`);
  return { dataset: `${domain}/${id}`, name: m.name, license: m.license || m.licenseId || null, attribution: m.attribution, attributionLink: m.attributionLink, terms: strip(JSON.stringify(m.metadata?.custom_fields || {})).slice(0, 600) };
}

// Any page: status, and the text with tags stripped (first 6,000 characters).
async function page(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  return { url, status: res.status, text: strip(text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')).slice(0, 6000) };
}

(async () => {
  for (const s of String(args.only || '').split(',').filter(Boolean)) {
    const kind = s.slice(0, s.indexOf(':')); const rest = s.slice(s.indexOf(':') + 1);
    try {
      const r = kind === 'socrata' ? await socrata(rest) : kind === 'url' ? await page(rest) : await arcgis(rest);
      console.log(`\nTERMS ${JSON.stringify(r)}`);
    } catch (e) { console.log(`\nTERMS ERR ${s}: ${e.message}`); }
  }
})();
