// Incremental ingest: scrape recent permits from each configured source and
// upsert them into Postgres.
//
// Usage:
//   node ingest/run.js                        all default areas, last 14 days
//   node ingest/run.js --area=oregon-statewide --days=30 --max=500
//   node ingest/run.js --all-details          re-fetch details for known permits

const { log } = require('apify');
const { SOURCES } = require('../src/sources.js');
const { getAdapter } = require('../src/adapters/index.js');
const { scorePermit } = require('../src/scoring.js');
const { toScorable } = require('../src/normalize.js');
const db = require('../db/index.js');

// Only the sources verified to work against live data.
const DEFAULT_AREAS = ['clackamas-county-or', 'oregon-statewide', 'austin-tx', 'miami-dade-fl'];
const TRADES = ['flooring', 'hvac', 'plumbing', 'electrical', 'painting', 'roofing'];

/**
 * All six trade scores, precomputed so the API can filter by trade across the
 * whole table. Scoring sees permitType recombined with the description.
 */
function tradeScoresFor(permit) {
  const scorable = toScorable(permit);
  const scores = {};
  for (const trade of TRADES) {
    scores[trade] = scorePermit(scorable, trade).score;
  }
  return scores;
}

function parseArgs(argv) {
  const args = { areas: DEFAULT_AREAS, days: 14, max: 500, allDetails: false };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'area') args.areas = value.split(',');
    else if (key === 'days') args.days = Number(value);
    else if (key === 'max') args.max = Number(value);
    else if (key === 'all-details') args.allDetails = true;
  }
  return args;
}

async function ingestArea(area, { days, max, allDetails }) {
  const source = SOURCES[area];
  if (!source) throw new Error(`Unknown area "${area}". Known: ${Object.keys(SOURCES).join(', ')}`);

  const runId = await db.startIngestRun(area);
  log.info(`[${area}] ingest start (last ${days} days, max ${max})`);

  try {
    const fetchSource = getAdapter(source.type);

    // Skip detail pages for permits already stored — one query for the whole
    // grid, then fetch details only for what's genuinely new. This is what
    // makes a wide date range affordable (and polite) on repeat runs.
    const selectDetailTargets = allDetails
      ? undefined
      : async (records) => {
          const known = await db.existingPermitNumbers(
            area,
            records.map((r) => r.permitNumber).filter(Boolean),
          );
          return records.filter((r) => !known.has(r.permitNumber));
        };

    const permits = await fetchSource(source, {
      includeIssued: true,
      daysBack: days,
      maxRecords: max,
      log,
      selectDetailTargets,
    });

    const withScores = permits.map((p) => ({ ...p, tradeScores: tradeScoresFor(p) }));
    const { written, inserted } = await db.upsertPermits(withScores, area);

    await db.finishIngestRun(runId, { seen: permits.length, inserted });
    log.info(`[${area}] done: ${permits.length} scraped, ${written} written, ${inserted} new`);
    return { seen: permits.length, written, inserted };
  } catch (err) {
    await db.finishIngestRun(runId, { error: err.message });
    log.error(`[${area}] FAILED: ${err.message}`);
    throw err;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await db.applySchema();

  const totals = { seen: 0, written: 0, inserted: 0 };
  const failures = [];

  for (const area of args.areas) {
    try {
      const result = await ingestArea(area, args);
      totals.seen += result.seen;
      totals.written += result.written;
      totals.inserted += result.inserted;
    } catch (err) {
      // One portal being down shouldn't abandon the others.
      failures.push({ area, message: err.message });
    }
  }

  log.info(`TOTAL: ${totals.seen} scraped, ${totals.written} written, ${totals.inserted} new`);
  if (failures.length) {
    for (const f of failures) log.error(`  failed: ${f.area} — ${f.message}`);
  }
  await db.close();
  process.exitCode = failures.length === args.areas.length ? 1 : 0;
}

if (require.main === module) {
  main().catch(async (err) => {
    log.error(err.stack || err.message);
    await db.close();
    process.exit(1);
  });
}

module.exports = { ingestArea, tradeScoresFor, TRADES };
