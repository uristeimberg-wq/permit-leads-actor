// Usage-analytics retention (ADR-37, owner decision 2026-11-15): raw events
// and sessions older than 13 months are deleted. Runs daily from the sync
// workflow. Prints what it deleted; a failure exits non-zero (rule 3).
//
//   node ingest/analytics_retention.js            (DATABASE_URL)
//
// Events go by server_received_at (the server's clock, not the device's).
// A session goes once its last activity is past the window; a device-to-user
// link goes once that device has no session left.

const RETENTION_MONTHS = 13;
const BATCH = 5000;

/** Deletes past the window. `query` is db/index.js query. Returns counts. */
async function pruneAnalytics(query, { months = RETENTION_MONTHS, batch = BATCH } = {}) {
  const cutoff = (await query('SELECT now() - make_interval(months => $1) AS t', [months])).rows[0].t;
  let events = 0;
  for (;;) {
    // Small batches keep each delete's lock short on a shared database.
    const { rowCount } = await query(`
      DELETE FROM analytics_events WHERE event_id IN (
        SELECT event_id FROM analytics_events WHERE server_received_at < $1 LIMIT $2)`, [cutoff, batch]);
    events += rowCount;
    if (rowCount < batch) break;
  }
  let sessions = 0;
  for (;;) {
    const { rowCount } = await query(`
      DELETE FROM analytics_sessions WHERE session_id IN (
        SELECT session_id FROM analytics_sessions WHERE last_active_at < $1 LIMIT $2)`, [cutoff, batch]);
    sessions += rowCount;
    if (rowCount < batch) break;
  }
  const { rowCount: identities } = await query(`
    DELETE FROM analytics_identities i
     WHERE i.first_linked_at < $1
       AND NOT EXISTS (SELECT 1 FROM analytics_sessions s WHERE s.anonymous_device_id = i.anonymous_device_id)`, [cutoff]);
  return { cutoff, events, sessions, identities };
}

if (require.main === module) {
  const db = require('../db/index.js');
  pruneAnalytics(db.query)
    .then((r) => {
      console.log(`analytics retention (${RETENTION_MONTHS} months, before ${new Date(r.cutoff).toISOString()}): `
        + `deleted ${r.events} events, ${r.sessions} sessions, ${r.identities} device links`);
    })
    .catch((err) => { console.error(`analytics retention failed (${err.code || err.name}): ${err.message}`); process.exitCode = 1; })
    .finally(() => db.close());
}

module.exports = { pruneAnalytics, RETENTION_MONTHS };
