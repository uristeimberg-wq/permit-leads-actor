const { fetchAccelaSource } = require('../src/adapters/accela.js');
const { SOURCES } = require('../src/sources.js');
const { scorePermit } = require('../src/scoring.js');

const log = { info: () => {}, warning: (m) => console.log('WARN ' + m) };
const TRADES = ['flooring', 'hvac', 'plumbing', 'electrical', 'painting', 'roofing'];

(async () => {
  const permits = await fetchAccelaSource(SOURCES['clackamas-county-or'], {
    includeIssued: true, daysBack: 10, maxRecords: 24, log,
  });
  console.log(`sample: ${permits.length} permits\n`);
  for (const trade of TRADES) {
    const scores = permits.map((p) => scorePermit(p, trade).score);
    const hits = scores.filter((s) => s >= 25).length;
    console.log(`${trade.padEnd(11)} leads at default minScore=25: ${hits}/${permits.length}`);
  }
  console.log('\n--- sample descriptions that SHOULD be leads but score 0 ---');
  const missed = permits.filter((p) => TRADES.every((t) => scorePermit(p, t).score === 0));
  missed.slice(0, 8).forEach((p) => console.log('  * ' + p.workDescription.slice(0, 115)));
  console.log(`\nscored 0 for every trade: ${missed.length}/${permits.length}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
