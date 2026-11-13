const { fetchAccelaSource } = require('../src/adapters/accela.js');
const { SOURCES } = require('../src/sources.js');
const { scorePermit, tierFor } = require('../src/scoring.js');

const log = { info: (m) => console.log('  ' + m), warning: (m) => console.log('  WARN ' + m) };
const area = process.argv[2] || 'clackamas-county-or';

(async () => {
  const permits = await fetchAccelaSource(SOURCES[area], {
    includeIssued: true, daysBack: 7, maxRecords: 8, log,
  });
  console.log(`\n=== ${permits.length} permits from ${area} ===`);
  for (const p of permits) {
    console.log(`\n${p.permitNumber} | ${p.status} | $${p.valuation} | ${p.filedDate}`);
    console.log(`  addr: ${p.address}`);
    console.log(`  desc: ${p.workDescription.slice(0, 110)}`);
  }
  const withDesc = permits.filter((p) => p.workDescription.trim()).length;
  const withVal = permits.filter((p) => p.valuation > 0).length;
  console.log(`\n--- populated: description ${withDesc}/${permits.length}, valuation ${withVal}/${permits.length}`);
  for (const trade of ['flooring', 'roofing', 'electrical']) {
    const scored = permits.map((p) => scorePermit(p, trade).score).filter((s) => s > 0);
    console.log(`  ${trade}: ${scored.length}/${permits.length} score > 0  [${scored.join(', ')}]`);
  }
})().catch((e) => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
