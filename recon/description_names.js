// Measures personal names inside Austin permit descriptions, and how many the
// display mask (src/description_names.js) catches. Read-only, rate-limited.
//
//   node recon/description_names.js [--months=12] [--out=recon/out/description-names]
//
// Nothing printed here contains a name the mask caught: samples are shown
// after masking. Possible misses are printed with every non-vocabulary word
// cut to its first letter, so the shape is visible but not the name.

const fs = require('node:fs');
const path = require('node:path');
const { maskNames, WORDS } = require('../src/description_names.js');

const CUE = /\(|residence|\bres\.|owner|\bmrs?\.?\s|\bms\.?\s/i;
const shape = (s) => s.replace(/[A-Za-z][A-Za-z'’-]*/g, (w) => (WORDS.has(w.toLowerCase()) ? w : `${w[0]}…`));

/** Pure: stats over descriptions. Exported for the offline test. */
function analyse(descriptions) {
  const masked = []; const cueNotMasked = []; const words = new Map();
  for (const d of descriptions) {
    if (!d) continue;
    const r = maskNames(d);
    if (r.masked) {
      masked.push(r.text);
      const kept = new Set(r.text.toLowerCase().split(/[^a-z'’-]+/));
      for (const w of d.toLowerCase().split(/[^a-z'’-]+/)) if (w && !kept.has(w)) words.set(w, (words.get(w) || 0) + 1);
    } else if (CUE.test(d)) cueNotMasked.push(shape(d));
  }
  const n = descriptions.filter(Boolean).length;
  return {
    descriptions: n,
    masked: masked.length,
    maskedPct: n ? +(100 * masked.length / n).toFixed(2) : 0,
    cueNotMasked: cueNotMasked.length,
    // A word masked in 8+ different descriptions is likely vocabulary, not a
    // name, so it is safe to print and is a candidate for WORDS.
    frequentMaskedWords: [...words].filter(([, c]) => c >= 8).sort((a, b) => b[1] - a[1]).slice(0, 60),
    maskedSamples: masked.slice(0, 40),
    missShapes: cueNotMasked.slice(0, 40),
  };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  const OUT = args.out || 'recon/out/description-names';
  const MONTHS = Number(args.months || 12);
  const AUSTIN = 'https://data.austintexas.gov'; const ID = '3syk-w9eu';
  const UA = 'permit-leads-feasibility/0.1 (research; read-only)';
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const since = new Date(); since.setUTCMonth(since.getUTCMonth() - MONTHS);
  const where = `issue_date >= '${since.toISOString().slice(0, 10)}T00:00:00' AND description IS NOT NULL`;
  const all = [];
  for (let off = 0; ; off += 50000) {
    const url = `${AUSTIN}/resource/${ID}.json?$select=${encodeURIComponent('permittype,description')}&$where=${encodeURIComponent(where)}`
      + `&$order=${encodeURIComponent(':id')}&$limit=50000&$offset=${off}`;
    let rows;
    for (let i = 1; ; i += 1) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        rows = await res.json(); break;
      } catch (err) { if (i >= 4) throw err; await sleep(2000 * 2 ** (i - 1)); }
    }
    all.push(...rows);
    if (rows.length < 50000) break;
    await sleep(500);
  }
  const report = { months: MONTHS, all: analyse(all.map((r) => r.description)) };
  report.buildingPermits = analyse(all.filter((r) => r.permittype === 'BP').map((r) => r.description));
  delete report.buildingPermits.maskedSamples; delete report.buildingPermits.missShapes; delete report.buildingPermits.frequentMaskedWords;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
module.exports = { analyse, shape };
