// Raw-record retention (ADR-14). raw_records is append-only: every change to a
// permit stores a new payload. Superseded payloads are kept for
// sources.raw_retention_days (default 90) so a mapping bug can be replayed,
// then deleted. The latest payload per permit is never deleted, and nothing a
// permit_parties row points at is deleted.
//
//   node ingest/prune.js            (DATABASE_URL)

const db = require('../db/index.js');

const DEFAULT_DAYS = 90;
const BATCH = 5000;

async function pruneRaw() {
  let total = 0;
  for (;;) {
    // Small batches keep each delete's lock short on a shared database.
    const { rowCount } = await db.query(`
      DELETE FROM raw_records WHERE id IN (
        SELECT r.id FROM raw_records r JOIN sources s ON s.id = r.source_id
         WHERE r.fetched_at < now() - make_interval(days => coalesce(s.raw_retention_days, $1))
           AND EXISTS (SELECT 1 FROM raw_records n
                        WHERE n.source_id = r.source_id AND n.source_key = r.source_key
                          AND (n.fetched_at, n.id) > (r.fetched_at, r.id))
           AND NOT EXISTS (SELECT 1 FROM permit_parties pp WHERE pp.raw_record_id = r.id)
         LIMIT $2)`, [DEFAULT_DAYS, BATCH]);
    total += rowCount;
    if (rowCount < BATCH) break;
  }
  return total;
}

async function main() {
  const deleted = await pruneRaw();
  console.log(`Raw retention: deleted ${deleted} superseded raw record(s) older than the retention window.`);
  await db.close();
}

if (require.main === module) {
  main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
}

module.exports = { pruneRaw };
