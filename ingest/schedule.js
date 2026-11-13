// Long-running scheduler: keeps the database current without anyone running
// ingest by hand.
//
// "Latest permits" is a claim about recency, so a platform that only refreshes
// when someone remembers to refresh it is quietly lying. This runs ingest on an
// interval and records every attempt — including failures — in ingest_runs,
// which is what the UI's "last refreshed" line reads.
//
//   node ingest/schedule.js
//   INGEST_INTERVAL_MINUTES=180 INGEST_DAYS=7 node ingest/schedule.js
//
// Deliberately dependency-free (no cron library). If you would rather use the
// system scheduler, this is the equivalent crontab entry:
//   0 */6 * * * cd /path/to/repo && node ingest/run.js --days=7

const { log } = require('apify');
const { ingestArea } = require('./run.js');
const { resolveScheduleConfig } = require('./config.js');
const db = require('../db/index.js');

// Defaults: every 6 hours, last 7 days, the pilot areas (Austin, Miami-Dade),
// each capped by its own source's maxPerRun. See ingest/config.js.
const CONFIG = resolveScheduleConfig(process.env);

let running = false;

async function runOnce() {
  // A slow run must never overlap the next tick: two ingests hitting the same
  // portal at once is both wasteful and impolite.
  if (running) {
    log.warning('Previous ingest still running; skipping this tick.');
    return;
  }
  running = true;

  for (const { area, max } of CONFIG.runs) {
    try {
      await ingestArea(area, { days: CONFIG.days, max, allDetails: false });
    } catch (err) {
      // ingestArea already recorded the failure against ingest_runs, so the UI
      // can show it. One portal being down must not stop the others.
      log.error(`[${area}] ingest failed: ${err.message}`);
    }
  }

  running = false;
  log.info(`Next refresh in ${CONFIG.intervalMinutes} minutes.`);
}

async function main() {
  await db.applySchema();
  const areaList = CONFIG.runs.map((r) => `${r.area} (max ${r.max})`).join(', ');
  log.info(`Scheduler started: every ${CONFIG.intervalMinutes}m, last ${CONFIG.days} days, areas: ${areaList}`);

  await runOnce();
  const timer = setInterval(runOnce, CONFIG.intervalMinutes * 60 * 1000);

  const shutdown = async () => {
    clearInterval(timer);
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch(async (err) => {
    log.error(err.stack || err.message);
    await db.close();
    process.exit(1);
  });
}

module.exports = { runOnce };
