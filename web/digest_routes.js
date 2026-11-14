// Digest email routes (ADR-20).
//
// Public (mounted before the demo gate; the signed token is the only key):
//   GET  /l/:token   one job, from a digest email, without signing in. The
//                    token names one permit and one subscription; it opens
//                    that permit's page and nothing else, and expires.
//   GET  /u/:token   unsubscribe confirmation page (a button, because mail
//                    scanners fetch every GET link in an email)
//   POST /u/:token   the unsubscribe itself: the form button, and RFC 8058
//                    one-click from Gmail/Yahoo (List-Unsubscribe-Post)
//
// Behind the demo gate:
//   GET  /digest/preview            subscriptions and a sample form
//   GET  /digest/preview/:id        the next email for one subscription,
//                                   rendered from live data, not sent or recorded
//   GET  /digest/sample?source=...  the same for settings that are not saved
//
// Rule 5: everything shown comes through db/pilot_queries.js (business names
// only, displayable unsuppressed phones). Rule 8: all third-party text is
// escaped. Pages are noindex, no-store and send no referrer.

const express = require('express');
const db = require('../db/index.js');
const pq = require('../db/pilot_queries.js');
const { verify, linkSecret, linkMaker } = require('../src/digest/links.js');
const { buildDigest, subscriptionOf } = require('../src/digest/build.js');
const R = require('../src/digest/render.js');
const { telHref, safeHttpUrl } = require('./public/links.js');

const { esc, C, FONT } = R;

const noStore = (res) => res.set({ 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });

const asyncRoute = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    noStore(res).status(500).type('html').send(page('Something went wrong', '<p>That page could not be loaded. Try again in a minute.</p>'));
  });
};

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} · Contractos</title>
<style>
*, *::before, *::after { box-sizing: border-box; }
html, body { overflow-x: clip; }
body { margin: 0; background: ${C.paper}; color: ${C.ink}; font: 400 16px/1.5 ${FONT}; -webkit-font-smoothing: antialiased; }
header { background: ${C.ink}; }
header div, main, footer div { max-width: 680px; margin: 0 auto; padding-left: 16px; padding-right: 16px; }
header div { min-height: 52px; display: flex; align-items: center; gap: 8px; color: ${C.plate}; font: 700 18px/1 ${FONT}; text-transform: uppercase; letter-spacing: 0.02em; }
header i { display: inline-block; width: 12px; height: 12px; background: ${C.accent}; }
main { padding-top: 24px; padding-bottom: 32px; }
h1 { margin: 0; font: 700 26px/1.2 ${FONT}; overflow-wrap: anywhere; }
h2 { margin: 0 0 8px; font: 700 15px/1.3 ${FONT}; text-transform: uppercase; letter-spacing: 0.03em; color: ${C.ink2}; }
p { margin: 8px 0 0; overflow-wrap: anywhere; }
.sub { color: ${C.muted}; font-size: 14px; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
.card { margin-top: 16px; padding: 16px; background: ${C.plate}; border: 2px solid ${C.ink}; }
.fresh { margin-top: 16px; padding: 10px 12px; background: ${C.okWash}; font-size: 13px; color: ${C.ink2}; }
.warn { background: ${C.warnWash}; color: ${C.warn}; font-weight: 700; }
.flag { display: inline-block; padding: 1px 6px; background: ${C.warnWash}; color: ${C.warn}; font: 700 12px/18px ${FONT}; text-transform: uppercase; }
.btn { display: inline-flex; align-items: center; min-height: 44px; margin-top: 12px; padding: 0 18px; border: 0; background: ${C.accent}; color: ${C.accentInk}; box-shadow: 0 3px 0 ${C.accentDeep}; font: 700 16px/1 ${FONT}; text-decoration: none; cursor: pointer; }
.btn:focus-visible, a:focus-visible { outline: 2px solid ${C.accentDeep}; outline-offset: 2px; }
a { color: ${C.accentDeep}; }
ul { margin: 8px 0 0; padding-left: 20px; }
footer { font-size: 12px; color: ${C.muted}; }
footer div { padding-top: 16px; padding-bottom: 24px; border-top: 1px solid ${C.rule}; }
</style>
</head>
<body>
<header><div><i aria-hidden="true"></i>Contractos</div></header>
<main>${body}</main>
<footer><div>Built on public permit records. Not affiliated with or endorsed by any government agency. Names that look like individuals are withheld.</div></footer>
</body>
</html>`;
}

const notFound = (res) => noStore(res).status(404).type('html').send(page('Link not valid',
  '<h1>This link has expired or is not valid</h1><p>Job links in digest emails work for 60 days. Open a newer email, or sign in to Contractos.</p>'));

async function subscriptionById(id) {
  const { rows: [s] } = await db.query('SELECT * FROM digest_subscriptions WHERE id = $1', [id]);
  return s || null;
}

function callBtn(phone) {
  const href = phone && telHref(phone.value);
  const text = phone && R.phoneText(phone.value);
  return href && text ? `<a class="btn" href="${esc(href)}">Call ${esc(text)}</a>` : '<p class="sub">No phone we can show for this business.</p>';
}

/** The job page behind a signed link: one permit or filing, nothing else. */
async function jobPage(permitId, sub) {
  const trades = sub.trades && sub.trades.length ? sub.trades : ['electrical'];
  const job = await pq.getJob(permitId, pq.parseFilters({ source: sub.source_area, trade: trades[0] }));
  if (!job) return null;
  const p = job.permit;
  const meta = job.meta || {};
  const tz = R.tzOf(sub.source_area);
  const lc = job.lifecycle || {};
  const stage = lc.stage || p.status_stage;
  const official = safeHttpUrl(p.permit_url);
  const isFiling = lc.filingKind === 'building_application';
  const parts = [];

  parts.push(`<h1>${esc(p.address || 'Address not published')}${p.zip && !String(p.address || "").includes(p.zip) ? ` <span class="sub">${esc(p.zip)}</span>` : ''}</h1>
<p>${esc(R.STAGE[stage] || stage || 'Stage not mapped')} · ${esc(p.permit_type || 'type not published')} · ${esc(R.money(p.valuation))}</p>
<p class="sub">${official ? `<a class="mono" href="${esc(official)}" rel="noopener noreferrer">${esc(p.permit_number)}</a> (the city's record)` : `<span class="mono">${esc(p.permit_number)}</span>`}
${lc.submittedOn ? ` · submitted ${esc(R.fmtDate(lc.submittedOn, tz))} (city's date)` : ''} · first seen by us ${esc(R.fmtDate(p.first_seen_at, tz))}</p>
${p.work_description ? `<p>${esc(p.work_description)}</p>` : ''}`);

  if (isFiling) {
    const { filer, withheld } = await pq.filersFor(permitId);
    let body;
    if (filer) {
      const flag = filer.role === 'expediter' ? ' <span class="flag">Expediter</span>' : '';
      body = `<p><strong>${esc(filer.name)}</strong>${flag} <span class="sub">(${esc(R.ROLE[filer.role] || filer.role)})</span></p><p class="sub">${esc(filer.basis)}.</p>`;
      if (filer.role === 'builder' && filer.contractorId) {
        const b = pq.publicContractor((await pq.contractorsById([filer.contractorId])).get(String(filer.contractorId)));
        body += callBtn(b && b.phone);
        const subs = ((await pq.builderSubs([filer.contractorId])).get(String(filer.contractorId)) || []).filter((s) => s.sub && s.sub.name);
        if (subs.length) {
          body += `<h2 style="margin-top:16px">This builder's past subs</h2><ul>${subs.map((s) => `<li>${esc(R.TRADE[s.trade] || s.trade)}: ${esc(s.sub.name)} (${s.jobs} of ${s.tradeJobs} jobs)</li>`).join('')}</ul>
<p class="sub">From issued permits on this builder's past jobs. History, not a claim about this job.</p>`;
        }
      } else if (filer.role === 'expediter') {
        body += '<p class="sub">An expediter files for someone else, so this is not the builder\'s number. The builder appears once the city issues the permit.</p>';
      }
    } else {
      body = `<p>${withheld ? 'Filed by an individual (name withheld).' : 'No business is named on this filing.'}</p>`;
    }
    parts.push(`<div class="card"><h2>Filed by</h2>${body}</div>`);
  } else {
    const gc = job.gc;
    let body = gc && gc.name ? `<p><strong>${esc(gc.name)}</strong></p>${callBtn(gc.phone)}` : `<p>${gc && gc.withheld ? 'An individual (name and contact withheld).' : 'No contractor on record.'}</p>`;
    const subs = job.gcHiring && job.gcHiring.subs.filter((s) => s.sub && s.sub.name).slice(0, 5);
    if (subs && subs.length) {
      body += `<h2 style="margin-top:16px">Who they hired for ${esc(R.TRADE[job.trade] || job.trade)}</h2><ul>${subs.map((s) => `<li>${esc(s.sub.name)} (${s.jobs} job${s.jobs === 1 ? '' : 's'})</li>`).join('')}</ul>`;
    }
    body += `<p class="sub">${job.tradePermitIssued ? `A ${esc(R.TRADE[job.trade] || job.trade)} permit is already on this job.` : `No ${esc(R.TRADE[job.trade] || job.trade)} permit on this job in the city's data yet. That does not mean nobody is hired.`}</p>`;
    parts.push(`<div class="card"><h2>Contractor</h2>${body}</div>`);
  }

  const apps = (lc.applications || []).filter(Boolean);
  if (apps.length) {
    parts.push(`<div class="card"><h2>How this job started</h2>${apps.map((a) => {
      const u = safeHttpUrl(a.url);
      return `<p>Application ${u ? `<a class="mono" href="${esc(u)}" rel="noopener noreferrer">${esc(a.permitNumber)}</a>` : `<span class="mono">${esc(a.permitNumber)}</span>`} · ${esc(R.STAGE[a.stage] || a.stage || '')}${a.submittedOn ? ` · submitted ${esc(R.fmtDate(a.submittedOn, tz))}` : ''}</p>`;
    }).join('')}</div>`);
  }

  const prov = job.provenance;
  const stale = !meta.lastSyncAt || Date.now() - new Date(meta.lastSyncAt) > 36 * 3600000;
  parts.push(`<p class="fresh${stale || meta.lastSyncStatus === 'failed' ? ' warn' : ''}">Last ${esc(meta.city || '')} sync ${esc(R.fmtDateTime(meta.lastSyncAt, tz))}${meta.lastSyncStatus === 'failed' ? ' (the latest attempt failed)' : ''}. ${meta.publicationLag ? `${esc(meta.publicationLag)}.` : ''}
${prov ? ` This record was fetched ${esc(R.fmtDateTime(prov.fetchedAt, tz))} (record ${esc(prov.rawRecordId)}).` : ''}</p>
<p class="sub">Source: ${esc(R.credits({ source: p.source_area, attribution: null }, false) || meta.attribution || p.source_area)}. Phones are as published on permits; nobody has called to check them.</p>
<p class="sub"><a href="/pilot/live/job.html?id=${encodeURIComponent(p.id)}&amp;source=${encodeURIComponent(sub.source_area)}">Open the full job page in Contractos</a> (sign-in).</p>`);
  return page(p.address || p.permit_number, parts.join('\n'));
}

const maskEmail = (e) => String(e || '').replace(/^(.)[^@]*(@.*)$/, '$1•••$2');

/** Stops every digest to this subscription's address, at once. */
async function unsubscribe(sub, channel) {
  await db.withTransaction(async (client) => {
    await client.query(`INSERT INTO email_suppressions (email, reason, channel) VALUES ($1, 'unsubscribe', $2)
                        ON CONFLICT (email) WHERE lifted_at IS NULL DO NOTHING`, [sub.email, channel]);
    await client.query(`UPDATE digest_subscriptions SET status = 'unsubscribed', unsubscribed_at = coalesce(unsubscribed_at, now()), updated_at = now()
                         WHERE email = $1`, [sub.email]);
  });
}

function publicRouter({ env = process.env } = {}) {
  const router = express.Router();
  const { secret } = linkSecret(env);

  router.get('/l/:token', asyncRoute(async (req, res) => {
    const t = verify(secret, req.params.token);
    if (!t || t.kind !== 'j') return notFound(res);
    const sub = await subscriptionById(t.subscriptionId);
    if (!sub) return notFound(res);
    const html = await jobPage(t.targetId, sub);
    if (!html) return notFound(res);
    return noStore(res).type('html').send(html);
  }));

  router.get('/u/:token', asyncRoute(async (req, res) => {
    const t = verify(secret, req.params.token);
    if (!t || t.kind !== 'u') return notFound(res);
    const sub = await subscriptionById(t.subscriptionId);
    if (!sub) return notFound(res);
    if (sub.status === 'unsubscribed') {
      return noStore(res).type('html').send(page('Unsubscribed', `<h1>You are unsubscribed</h1><p>${esc(maskEmail(sub.email))} gets no Contractos emails.</p>`));
    }
    return noStore(res).type('html').send(page('Unsubscribe', `<h1>Unsubscribe from Contractos emails?</h1>
<p>This stops every Contractos email to ${esc(maskEmail(sub.email))}, not just this digest.</p>
<form method="post" action="/u/${esc(req.params.token)}"><button class="btn" type="submit">Unsubscribe</button></form>`));
  }));

  router.post('/u/:token', express.urlencoded({ extended: false, limit: '1kb' }), asyncRoute(async (req, res) => {
    const t = verify(secret, req.params.token);
    if (!t || t.kind !== 'u') return notFound(res);
    const sub = await subscriptionById(t.subscriptionId);
    if (!sub) return notFound(res);
    const oneClick = req.body && req.body['List-Unsubscribe'] === 'One-Click';
    await unsubscribe(sub, oneClick ? 'one_click' : 'link');
    return noStore(res).type('html').send(page('Unsubscribed', `<h1>You are unsubscribed</h1>
<p>${esc(maskEmail(sub.email))} will get no more Contractos emails. If one was already on its way it may still arrive today.</p>
<p class="sub">Changed your mind? Reply to any digest or contact us, and we will turn it back on.</p>`));
  }));

  return router;
}

// --- Previews (behind the demo gate) ---------------------------------------

function sampleRow(q) {
  const trades = String(q.trades || 'electrical').split(',').filter((t) => pq.TRADES.includes(t));
  const early = ['homes', 'apartments', 'commercial', 'all'].includes(q.early) ? q.early : (q.early === 'none' ? null : 'homes');
  return {
    id: 0, email: 'preview@example.com', company: null, source_area: pq.SOURCES.includes(q.source) ? q.source : 'austin-tx',
    trades, early_segment: early, zips: null, min_valuation: null, frequency: 'daily',
  };
}

function previewRouter({ env = process.env } = {}) {
  const router = express.Router();
  const { secret, dev } = linkSecret(env);
  const baseUrl = env.PUBLIC_BASE_URL || '';

  const render = async (row, { since, real }) => {
    const model = await buildDigest(row, { mode: 'live', since, sent: real ? undefined : new Set() });
    // Saved subscriptions get the real signed links; a sample gets in-app links.
    const links = real
      ? linkMaker({ secret, baseUrl, subscriptionId: row.id })
      : { job: (id) => `/pilot/live/job.html?id=${id}&source=${encodeURIComponent(row.source_area)}`, unsubscribe: () => '#unsubscribe-link' };
    const note = real ? `the next email for subscription ${row.id}, from today's data; nothing is sent or recorded${dev ? '. LINK_SECRET is not set, so its links will not open' : ''}`
      : 'sample settings, not a saved subscription; links open the app';
    return R.renderDigest(model, links, { mailingAddress: env.MAILING_ADDRESS || null, appUrl: baseUrl || null, contactEmail: env.CONTACT_EMAIL || null, preview: note });
  };
  const sinceFrom = (q) => new Date(Date.now() - ([1, 7, 14, 30].includes(Number(q.days)) ? Number(q.days) : 1) * 86400000);

  router.get('/digest/preview', asyncRoute(async (_req, res) => {
    const { rows } = await db.query(`SELECT s.id, s.source_area, s.trades, s.early_segment, s.frequency, s.status,
      (SELECT max(finished_at) FROM digest_sends d WHERE d.subscription_id = s.id AND d.status IN ('sent','rendered')) AS last_email
      FROM digest_subscriptions s ORDER BY s.id`);
    const list = rows.length ? `<ul>${rows.map((r) => `<li><a href="/digest/preview/${r.id}">Subscription ${r.id}</a> · ${esc(r.source_area)} · ${esc([...(r.trades || []), r.early_segment && `early: ${r.early_segment}`].filter(Boolean).join(', '))} · ${esc(r.frequency)} · ${esc(r.status)} · last email ${esc(r.last_email ? new Date(r.last_email).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never')}</li>`).join('')}</ul>`
      : '<p class="sub">No subscriptions yet. Add one with <span class="mono">node ingest/digest_subscribe.js</span>.</p>';
    const opts = (xs, cur) => xs.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');
    noStore(res).type('html').send(page('Digest previews', `<h1>Digest email previews</h1>
<p>What a customer's email looks like, from today's data. Nothing here sends anything.</p>
<div class="card"><h2>Sample</h2><form method="get" action="/digest/sample" style="display:grid;gap:8px;max-width:360px">
<label>Market <select name="source" style="min-height:44px;width:100%">${opts(pq.SOURCES.map((s) => [s, s]), 'austin-tx')}</select></label>
<label>Trades <select name="trades" style="min-height:44px;width:100%">${opts([['electrical', 'Electrical'], ['plumbing', 'Plumbing'], ['mechanical', 'HVAC'], ['electrical,plumbing,mechanical', 'All three']], 'electrical')}</select></label>
<label>Early filings <select name="early" style="min-height:44px;width:100%">${opts([['homes', 'New homes'], ['apartments', 'Apartments'], ['commercial', 'Commercial'], ['all', 'All'], ['none', 'None']], 'homes')}</select></label>
<label>Covering <select name="days" style="min-height:44px;width:100%">${opts([['1', 'last day (a daily email)'], ['7', 'last 7 days (weekly)']], '1')}</select></label>
<button class="btn" type="submit">Show the email</button></form></div>
<div class="card"><h2>Subscriptions</h2>${list}</div>`));
  }));

  router.get('/digest/preview/:id', asyncRoute(async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) return notFound(res);
    const row = await subscriptionById(Number(req.params.id));
    if (!row) return notFound(res);
    const { rows: [last] } = await db.query(`SELECT max(period_end) AS t FROM digest_sends WHERE subscription_id = $1 AND mode = 'live'
                                              AND status IN ('sent','skipped_empty')`, [row.id]);
    const since = last && last.t ? new Date(last.t) : sinceFrom({ days: row.frequency === 'weekly' ? 7 : 1 });
    const email = await render(row, { since, real: true });
    noStore(res).type('html').send(email.html);
  }));

  router.get('/digest/sample', asyncRoute(async (req, res) => {
    const email = await render(sampleRow(req.query), { since: sinceFrom(req.query), real: false });
    noStore(res).type('html').send(email.html);
  }));

  return router;
}

module.exports = { publicRouter, previewRouter, jobPage, unsubscribe, sampleRow, maskEmail, subscriptionOf };
