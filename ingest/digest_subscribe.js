// Add, change, pause or list digest subscriptions (ADR-20). Until there is a
// sign-up screen, this is how a customer is put on the list.
//
//   node ingest/digest_subscribe.js --email=ops@acme-electric.com --area=austin-tx \
//        --trades=electrical,plumbing --early=homes [--company="Acme Electric"] \
//        [--frequency=daily|weekly] [--weekday=1] [--zips=78701,78702] [--min-value=50000] [--label=default]
//   node ingest/digest_subscribe.js --email=... --label=default --pause | --resume
//   node ingest/digest_subscribe.js --list
//
// Upserts on (email, label), so running the same command twice changes
// nothing. It never lifts an unsubscribe: a suppressed address stays
// suppressed until someone lifts its email_suppressions row by hand, on the
// customer's own written request.

const db = require('../db/index.js');
const { SOURCES } = require('../db/pilot_queries.js');

const TRADES = ['electrical', 'mechanical', 'plumbing'];
const SEGMENTS = ['homes', 'apartments', 'commercial', 'all'];

function args(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

/** Validated subscription fields, or throws with every problem listed. */
function parseSubscription(a) {
  const problems = [];
  const email = String(a.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push('--email is required');
  const area = a.area || '';
  if (!SOURCES.includes(area)) problems.push(`--area must be one of ${SOURCES.join(', ')}`);
  const trades = a.trades ? String(a.trades).split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (trades.some((t) => !TRADES.includes(t))) problems.push(`--trades takes ${TRADES.join(', ')}`);
  const early = a.early ? String(a.early) : null;
  if (early && !SEGMENTS.includes(early)) problems.push(`--early takes ${SEGMENTS.join(', ')}`);
  if (!trades.length && !early) problems.push('give --trades, --early or both');
  const frequency = a.frequency || 'daily';
  if (!['daily', 'weekly'].includes(frequency)) problems.push('--frequency is daily or weekly');
  const weekday = a.weekday === undefined ? 1 : Number(a.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) problems.push('--weekday is 0 (Sunday) to 6');
  const zips = a.zips ? String(a.zips).split(',').map((z) => z.trim()).filter(Boolean) : null;
  if (zips && zips.some((z) => !/^\d{5}$/.test(z))) problems.push('--zips takes 5-digit ZIPs, comma-separated');
  const minValuation = a['min-value'] === undefined ? null : Number(a['min-value']);
  if (minValuation !== null && !(minValuation >= 0)) problems.push('--min-value is a dollar amount');
  if (problems.length) throw new Error(problems.join('\n'));
  return {
    email, label: a.label || 'default', company: a.company || null, area, trades: [...new Set(trades)], early,
    zips, minValuation, frequency, weekday,
  };
}

async function upsert(s) {
  const { rows: [r] } = await db.query(`
    INSERT INTO digest_subscriptions (email, label, company, source_area, trades, early_segment, zips, min_valuation, frequency, send_weekday)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (email, label) DO UPDATE SET
      company = EXCLUDED.company, source_area = EXCLUDED.source_area, trades = EXCLUDED.trades,
      early_segment = EXCLUDED.early_segment, zips = EXCLUDED.zips, min_valuation = EXCLUDED.min_valuation,
      frequency = EXCLUDED.frequency, send_weekday = EXCLUDED.send_weekday, updated_at = now()
    RETURNING id, status`, [s.email, s.label, s.company, s.area, s.trades, s.early, s.zips, s.minValuation, s.frequency, s.weekday]);
  return r;
}

async function main() {
  const a = args(process.argv.slice(2));
  await db.applySchema();
  if (a.list) {
    const { rows } = await db.query(`
      SELECT s.id, s.email, s.label, s.source_area, s.trades, s.early_segment, s.frequency, s.status,
             (SELECT max(finished_at) FROM digest_sends d WHERE d.subscription_id = s.id AND d.status IN ('sent','rendered')) AS last_email,
             EXISTS (SELECT 1 FROM email_suppressions e WHERE e.email = s.email AND e.lifted_at IS NULL) AS suppressed
        FROM digest_subscriptions s ORDER BY s.id`);
    console.table(rows);
    return;
  }
  if (a.pause || a.resume) {
    const email = String(a.email || '').toLowerCase();
    const { rowCount } = await db.query(`UPDATE digest_subscriptions SET status = $3, updated_at = now()
                                          WHERE email = $1 AND label = $2 AND status <> 'unsubscribed'`, [email, a.label || 'default', a.pause ? 'paused' : 'active']);
    console.log(rowCount ? `${a.pause ? 'Paused' : 'Resumed'}.` : 'No such subscription, or it was unsubscribed (that needs the customer\'s own request to undo).');
    return;
  }
  const s = parseSubscription(a);
  const r = await upsert(s);
  const { rows: [sup] } = await db.query('SELECT 1 FROM email_suppressions WHERE email = $1 AND lifted_at IS NULL', [s.email]);
  console.log(`Subscription ${r.id}: ${r.status}.${sup ? ' This address is suppressed (unsubscribed or bounced); it gets nothing until that is lifted.' : ''}`);
}

if (require.main === module) {
  main().then(() => db.close()).catch(async (err) => { console.error(err.message); await db.close(); process.exit(1); });
}

module.exports = { parseSubscription, upsert };
