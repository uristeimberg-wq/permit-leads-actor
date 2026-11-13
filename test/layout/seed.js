// Synthetic Austin-shaped permits for the layout check (CI only). Every name
// starts with "Sample" so nothing can pass for a real company, and phones are
// 555 numbers. Runs the real ingest and resolver over a stubbed fetch.
const db = require('../../db');
const { ingestArea } = require('../../ingest/run');
const { resolveAll } = require('../../ingest/resolve');

let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const zips = ['78704', '78745', '78702', '78723', '78744', '78748', '78741', '78753', '78758', '78759', '78731', '78703'];
const daysAgo = (n) => `${new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)}T00:00:00.000`;
const gcs = Array.from({ length: 30 }, (_, i) => [`Sample Builders ${String(i + 1).padStart(2, '0')} LLC`, `512555${1000 + i}`]);
const subs = Array.from({ length: 24 }, (_, i) => [`Sample ${['Electric', 'Plumbing', 'Air'][i % 3]} ${i + 1} Inc`, `512556${1000 + i}`]);
const rows = [];
let n = 100000;
for (let i = 0; i < 1200; i++) {
  const ago = Math.floor(Math.pow(rnd(), 1.1) * 190) + 2;
  const g = gcs[Math.min(29, Math.floor(Math.pow(rnd(), 2.2) * 30))];
  const zip = pick(zips);
  n += 1;
  rows.push({
    permit_number: `2026-${n} BP`, permittype: 'BP', permit_type_desc: 'Building Permit',
    description: pick(['Remodel kitchen and bath, new circuits', 'New single family residence', 'Interior finish-out for retail shell', 'Addition of primary suite with a much longer description that has to wrap on a phone screen']),
    status_current: pick(['Active', 'Issued', 'Final']), issue_date: daysAgo(ago),
    original_address1: `${Math.floor(rnd() * 9000) + 100} ${pick(['OAK', 'ELM', 'CEDAR', 'LAMAR', 'CONGRESS', 'BURNET'])} ${pick(['ST', 'DR', 'LN', 'BLVD'])}`,
    original_city: 'AUSTIN', original_state: 'TX', original_zip: zip,
    contractor_company_name: g[0], contractor_phone: g[1], contractor_trade: null,
    total_job_valuation: rnd() < 0.15 ? null : String(Math.round(Math.exp(10 + rnd() * 3.5))),
  });
  for (const [code, k] of [['EP', 0], ['PP', 1], ['MP', 2]]) {
    if (ago < 10 || rnd() < 0.35) continue;
    const s = subs[k + 3 * Math.floor(Math.pow(rnd(), 1.8) * 8)];
    rows.push({
      permit_number: `2026-${n} ${code}`, permittype: code, permit_type_desc: `${code} Permit`, description: 'Trade work',
      status_current: 'Active', issue_date: daysAgo(Math.max(1, ago - Math.floor(rnd() * 40))),
      original_address1: 'x', original_city: 'AUSTIN', original_state: 'TX', original_zip: zip,
      contractor_company_name: s[0], contractor_phone: s[1], contractor_trade: null, total_job_valuation: null,
    });
  }
}
// Plan-review cases for the Early screen: same synthetic naming, no people.
const cases = Array.from({ length: 40 }, (_, i) => ({
  permit_number: `2026-${200000 + i} PR`, permit_type: 'Plan Review', sub_type: pick(['R- 101 Single Family Houses', 'C-1000 Commercial Remodel']),
  folder_description: pick(['New single family residence', 'Interior remodel of a sample retail shell with a long description that wraps on a phone']),
  folderrsn: String(900000 + i), status_current: pick(['Pending', 'In Review', 'Awaiting Update', 'Approved']),
  applied_date: daysAgo(Math.floor(rnd() * 28) + 1), status_date: daysAgo(1),
  project_name: `${Math.floor(rnd() * 9000) + 100} ${pick(['OAK', 'ELM', 'LAMAR'])} ST`, total_job_valuation: String(Math.round(Math.exp(10 + rnd() * 3))),
}));
// Each dataset answers once; later pages and windows are empty.
const pages = { '3syk-w9eu': [rows], 'n8ck-xkda': [cases] };
global.fetch = async (url) => {
  const id = Object.keys(pages).find((k) => String(url).includes(k));
  const page = (id && pages[id].shift()) || [];
  return { ok: true, json: async () => page, text: async () => '' };
};

(async () => {
  await db.applySchema();
  await ingestArea('austin-tx', { days: 200, max: 100000, allDetails: false });
  await ingestArea('austin-plan-review-tx', { max: 1000, allDetails: false });
  await resolveAll();
  console.log(`seeded ${rows.length} sample permits`);
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
