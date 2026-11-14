// Times every query behind the overview and the other first screens directly
// against DATABASE_URL, so slow SQL can be told apart from network, cold start
// and payload. Read-only. Prints timings only.
//
//   DATABASE_URL=... node test/perf/queries.js

const db = require('../../db/index.js');
const oq = require('../../db/overview_queries.js');
const pq = require('../../db/pilot_queries.js');

async function time(label, fn) {
  const t0 = performance.now();
  try { await fn(); } catch (err) { console.log(`${label.padEnd(40)} FAILED ${err.message}`); return; }
  console.log(`${label.padEnd(40)} ${String(Math.round(performance.now() - t0)).padStart(7)} ms`);
}

(async () => {
  await time('connect + SELECT 1 (wakes compute)', () => db.query('SELECT 1'));
  await time('SELECT 1 (warm)', () => db.query('SELECT 1'));
  for (const source of pq.SOURCES) {
    console.log(`\n== ${source}`);
    await time('sourceMeta', () => pq.sourceMeta(source));
    await time('overview.totals', () => oq.totals(source));
    await time('overview.weekly', () => oq.weekly(source));
    await time('overview.places', () => oq.places(source));
    await time('overview.topGcs', () => oq.topGcs(source));
    await time('overview.recentBuilding', () => oq.recentBuilding(source));
    await time('overview.repeatHiring (3 trades)', () => oq.repeatHiring(source));
    await time('overview() all, in parallel', () => oq.overview(source));
    const f = pq.parseFilters({ source, trade: 'electrical', months: '12' });
    await time('listGcs electrical 12m', () => pq.listGcs(f));
    await time('marketBaseline electrical 12m', () => pq.marketBaseline(f));
  }
  await db.close();
})().catch(async (err) => { console.error(err.message); await db.close(); process.exit(1); });
