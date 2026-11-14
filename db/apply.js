// Applies pending migrations and exits: Railway's pre-deploy command
// (railway.json), so a deploy's schema is in place before its code serves
// traffic. Same runner and advisory lock as the sync job (db/migrate.js), so
// a deploy and a sync starting together cannot both apply. A failed
// migration exits non-zero, and Railway then keeps the previous deploy live.
//
//   node db/apply.js

const db = require('./index.js');

async function main() {
  const before = await db.schemaVersion().catch(() => 0);
  await db.applySchema();
  const after = await db.schemaVersion();
  // The caller names itself (the container start passes "start"), so a deploy
  // log shows which step applied what; no argument is Railway's pre-deploy.
  const from = process.argv[2] || 'pre-deploy or manual';
  console.log(`Migrations (${from}): schema at ${after} (was ${before}).`);
  await db.close();
}

main().catch(async (err) => {
  console.error(err.stack || err.message);
  await db.close().catch(() => {});
  process.exit(1);
});
