// One digest run (ADR-20): every active subscription that is due today gets
// at most one email per mode, carrying only records it has not been sent.
//
// Per subscription, in order:
//   1. due?           daily, or weekly on its weekday (UTC date of the run)
//   2. suppressed?    an active email_suppressions row -> skipped_suppressed
//   3. allowlisted?   live mode with EMAIL_ALLOWLIST set -> skipped_allowlist
//   4. claim the day  INSERT ... ON CONFLICT on (subscription, mode, day): a
//                     second run the same day finds the row and sends nothing
//                     (a 'failed' row is retried; a 'started' row is not,
//                     because the provider may have accepted it)
//   5. build, render, send; then record digest_items and the outcome in one
//      transaction. Empty -> skipped_empty, no email.
// Every attempt leaves a digest_sends row with its status and error class
// (rule 3). The caller exits non-zero when any subscription failed.

const db = require('../../db/index.js');
const { buildDigest } = require('./build.js');
const { renderDigest } = require('./render.js');
const { linkMaker, linkSecret } = require('./links.js');

const DAY_MS = 86400000;

const utcDay = (d) => new Date(d).toISOString().slice(0, 10);

function isDue(sub, now) {
  if (sub.frequency === 'weekly') return new Date(now).getUTCDay() === Number(sub.send_weekday);
  return true;
}

async function periodStart(subId, mode, frequency, now) {
  const { rows: [r] } = await db.query(`
    SELECT max(period_end) AS last FROM digest_sends
     WHERE subscription_id = $1 AND mode = $2 AND status IN ('sent', 'rendered', 'skipped_empty')`, [subId, mode]);
  if (r && r.last) return new Date(r.last);
  return new Date(new Date(now).getTime() - (frequency === 'weekly' ? 7 : 1) * DAY_MS);
}

async function record(id, fields) {
  const keys = Object.keys(fields);
  await db.query(`UPDATE digest_sends SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, finished_at = now() WHERE id = $1`,
    [id, ...keys.map((k) => fields[k])]);
}

/** A row for a subscription that is not sent today, so the skip is on record. */
async function skip(sub, mode, now, status) {
  await db.query(`
    INSERT INTO digest_sends (subscription_id, mode, send_date, period_start, period_end, status, finished_at)
    VALUES ($1, $2, $3, $4, $4, $5, now())
    ON CONFLICT (subscription_id, mode, send_date) DO NOTHING`, [sub.id, mode, utcDay(now), new Date(now), status]);
}

/**
 * @param {object} opts
 * @param {object} opts.provider   src/email/providers.js providerFromEnv()
 * @param {object} [opts.env]      LINK_SECRET, PUBLIC_BASE_URL, MAILING_ADDRESS, CONTACT_EMAIL
 * @param {Date}   [opts.now]
 * @param {number} [opts.only]     one subscription id
 * @returns {Promise<{mode, results: object[], failed: number, linkSecretDev: boolean}>}
 */
async function runDigests({ provider, env = process.env, now = new Date(), only = null, log = () => {} } = {}) {
  const mode = provider.mode;
  const { secret, dev } = linkSecret(env, { required: mode === 'live' });
  const baseUrl = env.PUBLIC_BASE_URL || 'http://localhost:3000';
  const { rows: subs } = await db.query(`
    SELECT * FROM digest_subscriptions WHERE status = 'active' AND ($1::bigint IS NULL OR id = $1) ORDER BY id`, [only]);
  const { rows: suppressed } = await db.query('SELECT email FROM email_suppressions WHERE lifted_at IS NULL');
  const blocked = new Set(suppressed.map((r) => r.email));
  const results = [];

  for (const sub of subs) {
    const out = { subscription: Number(sub.id), market: sub.source_area, status: null, items: 0 };
    results.push(out);
    if (!isDue(sub, now)) { out.status = 'not_due'; continue; }
    if (blocked.has(sub.email)) { out.status = 'skipped_suppressed'; await skip(sub, mode, now, out.status); continue; }
    if (mode === 'live' && provider.allowlist.length && !provider.allowlist.includes(sub.email)) {
      out.status = 'skipped_allowlist'; await skip(sub, mode, now, out.status); continue;
    }

    const since = await periodStart(sub.id, mode, sub.frequency, now);
    const { rows: [claim] } = await db.query(`
      INSERT INTO digest_sends (subscription_id, mode, send_date, period_start, period_end, status, provider)
      VALUES ($1, $2, $3, $4, $5, 'started', $6)
      ON CONFLICT (subscription_id, mode, send_date) DO UPDATE
        SET status = 'started', period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
            provider = EXCLUDED.provider, error_class = NULL, error_message = NULL, started_at = now(), finished_at = NULL
        WHERE digest_sends.status = 'failed'
      RETURNING id`, [sub.id, mode, utcDay(now), since, new Date(now), provider.name]);
    if (!claim) { out.status = 'already_done_today'; continue; }
    out.sendId = Number(claim.id);

    try {
      const model = await buildDigest(sub, { mode, since, until: now });
      out.items = model.items.length;
      if (!model.items.length) {
        out.status = 'skipped_empty';
        await record(claim.id, { status: 'skipped_empty', item_count: 0 });
        continue;
      }
      const links = linkMaker({ secret, baseUrl, subscriptionId: sub.id, now: new Date(now).getTime() });
      const email = renderDigest(model, links, {
        mailingAddress: env.MAILING_ADDRESS || null, appUrl: env.PUBLIC_BASE_URL || null, contactEmail: env.CONTACT_EMAIL || null,
        preview: mode === 'dry_run' ? 'dry run, not sent' : null,
      });
      const unsubscribe = links.unsubscribe();
      const sentMsg = await provider.send({
        key: `digest-${claim.id}`,
        to: sub.email, from: provider.from, replyTo: provider.replyTo,
        subject: email.subject, html: email.html, text: email.text,
        // RFC 8058 one-click unsubscribe (Gmail and Yahoo bulk-sender rules).
        headers: { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
      await db.withTransaction(async (client) => {
        for (const it of model.items) {
          await client.query(`INSERT INTO digest_items (subscription_id, mode, section, permit_id, send_id)
                              VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [sub.id, mode, it.section, it.permitId, claim.id]);
        }
        await client.query(`UPDATE digest_sends SET status = $2, item_count = $3, subject = $4, provider_message_id = $5, finished_at = now() WHERE id = $1`,
          [claim.id, mode === 'live' ? 'sent' : 'rendered', model.items.length, email.subject, sentMsg.id]);
      });
      out.status = mode === 'live' ? 'sent' : 'rendered';
      out.subject = email.subject;
      log(`subscription ${sub.id} (${sub.source_area}): ${out.status}, ${out.items} items`);
    } catch (err) {
      out.status = 'failed';
      out.errorClass = err.errorClass || 'unknown';
      out.error = String(err.message || err).slice(0, 500);
      await record(claim.id, { status: 'failed', error_class: out.errorClass, error_message: out.error });
      log(`subscription ${sub.id} (${sub.source_area}): FAILED (${out.errorClass}) ${out.error}`);
    }
  }
  return { mode, results, failed: results.filter((r) => r.status === 'failed').length, linkSecretDev: dev };
}

module.exports = { runDigests, isDue, periodStart, utcDay };
