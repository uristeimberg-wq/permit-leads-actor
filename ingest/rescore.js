// Re-score every stored permit with the current trade rules (src/scoring.js).
// Run once after a rule change; ingest scores new and changed permits itself.
// Started from the sync workflow's `rescore` input.
//
// Neon is near its storage limit and every UPDATE leaves a dead row version
// behind, so it writes only rows whose scores change, in batches, with a plain
// VACUUM after each written batch so the space is reused inside the table
// rather than growing it. trade_scores is not in permit_tracked(), so no
// permit_versions rows are written.
//
//   node ingest/rescore.js [--batch=20000] [--dry-run]

const db = require('../db/index.js');
const { tradeScoresFor } = require('./run.js');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

/** Scores for one stored row, as ingest would compute them now. */
function rescoreRow(r) {
  return tradeScoresFor({ permitType: r.permit_type, workDescription: r.work_description || '',
    valuation: r.valuation == null ? null : Number(r.valuation), status: r.status });
}

const canon = (o) => JSON.stringify(Object.entries(o || {}).sort(([x], [y]) => x.localeCompare(y)));
const SUB = ['electrical', 'plumbing', 'hvac'];
const isLead = (o) => SUB.some((t) => Number((o || {})[t]) >= 25);

async function rescoreAll({ batch = 20000, dryRun = false, vacuum = true } = {}) {
  const t = { read: 0, changed: 0, gainedLead: 0, lostLead: 0 };
  let after = 0;
  for (;;) {
    const { rows } = await db.query(`
      SELECT id, permit_type, work_description, valuation, status, trade_scores
        FROM permits WHERE id > $1 ORDER BY id LIMIT $2`, [after, batch]);
    if (!rows.length) break;
    after = Number(rows[rows.length - 1].id);
    t.read += rows.length;

    const updates = [];
    for (const r of rows) {
      const next = rescoreRow(r);
      if (canon(next) === canon(r.trade_scores)) continue;
      updates.push({ id: Number(r.id), scores: next });
      if (isLead(next) && !isLead(r.trade_scores)) t.gainedLead += 1;
      if (!isLead(next) && isLead(r.trade_scores)) t.lostLead += 1;
    }
    t.changed += updates.length;
    if (!dryRun && updates.length) {
      await db.query(`
        UPDATE permits p SET trade_scores = u.scores
          FROM jsonb_to_recordset($1::jsonb) AS u(id bigint, scores jsonb)
         WHERE p.id = u.id`, [JSON.stringify(updates)]);
      if (vacuum) await db.query('VACUUM permits');
    }
  }
  return t;
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  rescoreAll({ batch: Number(arg('batch', 20000)), dryRun })
    .then((t) => {
      console.log(`### Trade re-score${dryRun ? ' (dry run, nothing written)' : ''}\n`);
      console.log(`- permits read: ${t.read}; scores changed: ${t.changed}`);
      console.log(`- became an electrical, plumbing or HVAC lead (score 25+): ${t.gainedLead}; stopped being one: ${t.lostLead}`);
    })
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(() => db.close());
}

module.exports = { rescoreAll, rescoreRow };
