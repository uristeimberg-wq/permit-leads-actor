// Reads what governs Travis CAD appraisal data: the district's public data
// page, its export layout, and the Texas statutes on confidential owner
// information (Tax Code 25.025-25.027, 22.27; Gov't Code 552.1175, 552.007).
// Read-only. Gov sites are reachable from Actions, not from the dev container.
//
//   node recon/tcad_terms.js --out=recon/out/tcad
//
// Prints statute text and the export file list; saves the layout zip for the
// workflow's unzip step. Prints no property or owner records.

const fs = require('node:fs');
const path = require('node:path');

const UA = 'permit-leads-compliance/0.1 (research; read-only)';
const strip = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#167;|&sect;/g, '§').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');

async function get(url, binary = false) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} <- ${url}`);
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
}

/** Text of one section ("25.025") out of a chapter's plain text. */
function section(text, num) {
  const start = text.search(new RegExp(`Sec\\.\\s*${num.replace('.', '\\.')}\\.`));
  if (start < 0) return null;
  const rest = text.slice(start + 10);
  const next = rest.search(/\n\s*Sec\.\s*\d+\.\d+[A-Z]?\./);
  return text.slice(start, start + 10 + (next < 0 ? 6000 : next)).trim();
}

async function chapter(code, ch) {
  const urls = [
    `https://statutes.capitol.texas.gov/Docs/${code}/htm/${code}.${ch}.htm`,
    `https://tcss.legis.texas.gov/resources/${code}/htm/${code}.${ch}.htm`,
  ];
  for (const url of urls) {
    try {
      const t = strip(await get(url));
      if (/Sec\.\s*\d+\.\d+/.test(t)) return { url, text: t };
    } catch (err) { console.log(`  (${err.message})`); }
  }
  return { url: null, text: '' };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  const OUT = args.out || 'recon/out/tcad';
  fs.mkdirSync(OUT, { recursive: true });

  const wanted = [['TX', '25', ['25.025', '25.026', '25.027']], ['TX', '22', ['22.27']], ['GV', '552', ['552.007', '552.1175', '552.231']]];
  for (const [code, ch, secs] of wanted) {
    const { url, text } = await chapter(code, ch);
    console.log(`\n===== ${code} ch. ${ch}: ${url || 'UNREAD'}`);
    for (const s of secs) {
      const body = section(text, s);
      console.log(`\n----- Sec. ${s} -----\n${body ? body.slice(0, 5000) : 'NOT FOUND'}`);
    }
  }

  console.log('\n===== Travis CAD public information page');
  try {
    const html = await get('https://traviscad.org/publicinformation/');
    const links = [...html.matchAll(/href="([^"]+\.(?:zip|pdf|csv|xlsx?))"/gi)].map((m) => m[1]);
    console.log([...new Set(links)].join('\n'));
    const text = strip(html);
    for (const kw of ['terms', 'licen', 'commercial', 'disclaim', 'confidential', 'resale', 'warrant']) {
      const i = text.toLowerCase().indexOf(kw);
      console.log(`[${kw}] ${i < 0 ? 'not on page' : text.slice(Math.max(0, i - 200), i + 300).replace(/\n/g, ' ')}`);
    }
    const layout = links.find((l) => /layout/i.test(l));
    if (layout) {
      const url = new URL(layout, 'https://traviscad.org/').toString();
      fs.writeFileSync(path.join(OUT, 'layout.zip'), await get(url, true));
      console.log(`saved layout: ${url}`);
    }
  } catch (err) { console.log(`UNREAD: ${err.message}`); }
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
module.exports = { section, strip };
