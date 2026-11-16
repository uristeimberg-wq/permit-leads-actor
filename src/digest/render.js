// The digest email: subject, HTML and plain text from a digest model
// (src/digest/build.js). Pure; no database, no network.
//
// Email HTML is not web HTML: Gmail and Outlook drop <style> blocks in places,
// ignore web fonts and modern colour syntax, and Outlook lays out with Word.
// So: one 600px-max column of tables, inline styles, hex colours (the
// Formwork palette, web/public/pilot/live/live.css, converted), system fonts,
// 16px body text and 44px-tall tap targets for phones.
//
// Rules this file keeps (CLAUDE.md):
//   5  only business names reach it (build.js passes publicContractor /
//      publicFiler output); a withheld party is shown as withheld.
//   6  every item names its permit number and links to the city's record.
//   7  the header states the last sync and the source's publication lag.
//   8  every third-party value goes through esc().
// And the sales brief's banned claims: no "verified", "unhired",
// "real-time", "live" or "open now" (render.test.js checks).

const { telHref, safeHttpUrl } = require('../../web/public/links.js');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const C = {
  paper: '#f4f1ea', plate: '#fbfaf7', ink: '#1d2330', ink2: '#333a47', muted: '#5b6170', rule: '#d6d1c6',
  accent: '#b5541c', accentDeep: '#8a3e12', accentInk: '#fbfaf7', warnWash: '#f8e7df', warn: '#8f2a1c', okWash: '#eef0e6',
};
const FONT = "Helvetica, Arial, 'Segoe UI', sans-serif";
const MONO = "'SFMono-Regular', Menlo, Consolas, 'Courier New', monospace";

const TRADE = { electrical: 'electrical', mechanical: 'HVAC', plumbing: 'plumbing' };
const STAGE = {
  pre_application: 'Pre-application', submitted: 'Submitted', in_review: 'In review', corrections: 'Corrections requested',
  approved: 'Approved, not issued', issued: 'Issued', unknown: 'Stage not mapped',
};
const ROLE = {
  builder: 'builder',
  expediter: 'permit expediter, not the builder',
  unknown: 'role not known yet',
};
// Credit lines (web/public/pilot/live/live.js attribution()), used when the
// sources row has no attribution_text. City of Miami's CC BY credit must
// appear wherever its data does.
const CREDIT = {
  'austin-tx': 'City of Austin, Texas – data.austintexas.gov, dataset 3syk-w9eu',
  'austin-plan-review-tx': 'City of Austin, Texas – data.austintexas.gov, dataset n8ck-xkda',
  'miami-dade-fl': 'Miami-Dade County Open Data (ArcGIS building permits layer)',
  'miami-city-fl': '© 2019 City of Miami, Department of Innovation and Technology, GIS Team. Licensed CC BY 4.0 (creativecommons.org/licenses/by/4.0); normalized by us',
  'raleigh-nc': 'City of Raleigh Open Data',
};
function credits(m, early) {
  const xs = [m.attribution || CREDIT[m.source]];
  if (early) xs.push(m.earlyAttribution || CREDIT[m.earlySource]);
  return [...new Set(xs.filter(Boolean))].join('; ');
}

// Market time zones, for dates a customer reads.
const TZ = { 'austin-tx': 'America/Chicago' };
const tzOf = (source) => TZ[source] || 'America/New_York';

function fmtDate(d, tz) {
  if (!d) return null;
  const s = String(d);
  const date = s.length === 10 ? new Date(`${s}T12:00:00Z`) : new Date(s);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: s.length === 10 ? 'UTC' : tz });
}
function fmtDateTime(d, tz) {
  if (!d) return 'never';
  return new Date(d).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' });
}
const money = (v) => (v == null ? 'Value not published' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
function phoneText(v) {
  const d = String(v || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null;
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// ---------------------------------------------------------------------------
// Pieces

function callButton(phone) {
  const href = phone && telHref(phone.value);
  const text = phone && phoneText(phone.value);
  if (!href || !text) return `<p style="margin:12px 0 0;font:400 14px/1.4 ${FONT};color:${C.muted};">No phone we can show for this business.</p>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 0;"><tr>
<td style="background:${C.accent};border-bottom:3px solid ${C.accentDeep};">
<a href="${esc(href)}" style="display:inline-block;padding:12px 18px;min-height:20px;font:700 16px/20px ${FONT};color:${C.accentInk};text-decoration:none;">Call ${esc(text)}</a>
</td></tr></table>`;
}

function jobLink(href, label = 'Open the job') {
  return `<a href="${esc(href)}" style="display:inline-block;padding:12px 0;font:700 15px/20px ${FONT};color:${C.accentDeep};text-decoration:underline;">${esc(label)} &rarr;</a>`;
}

function officialLink(item) {
  const url = safeHttpUrl(item.url);
  const num = esc(item.permitNumber);
  return url ? `<a href="${esc(url)}" style="color:${C.ink2};font-family:${MONO};">${num}</a>` : `<span style="font-family:${MONO};">${num}</span>`;
}

function who(party, { withheld } = {}) {
  if (party && party.name) return esc(party.name);
  if (withheld || (party && party.withheld)) return 'An individual (name withheld)';
  return null;
}

function card(inner) {
  return `<tr><td style="padding:16px 20px;border-top:1px solid ${C.rule};background:${C.plate};">${inner}</td></tr>`;
}

function earlyCard(item, links, tz, trades) {
  const filer = item.filer;
  let filedBy;
  if (filer) {
    const flag = filer.role === 'expediter'
      ? ` <span style="display:inline-block;padding:1px 6px;background:${C.warnWash};color:${C.warn};font:700 12px/18px ${FONT};text-transform:uppercase;letter-spacing:0.03em;">Expediter</span>`
      : '';
    filedBy = `Filed by <strong>${esc(filer.name)}</strong>${flag} <span style="color:${C.muted};">(${esc(ROLE[filer.role] || filer.role)})</span>`;
  } else {
    filedBy = item.filerWithheld ? 'Filed by an individual (name withheld)' : '<span style="color:' + C.muted + ';">No business named on the filing</span>';
  }
  const dates = [
    item.submittedOn ? `submitted ${fmtDate(item.submittedOn, tz)} (city's date)` : 'submission date not published',
    `first seen by us ${fmtDate(item.firstSeenAt, tz)}`,
  ].join(' · ');
  const subs = (item.builderSubs || []).filter((s) => trades.includes(s.trade) && s.sub && s.sub.name);
  const subLine = subs.length
    ? `<p style="margin:8px 0 0;font:400 14px/1.45 ${FONT};color:${C.ink2};">This builder's past ${esc(list([...new Set(subs.map((s) => TRADE[s.trade]))]))} subs: ${subs.map((s) => `${esc(s.sub.name)} (${s.jobs} of ${s.tradeJobs} jobs)`).join('; ')}.</p>`
    : '';
  const phone = filer && filer.role === 'builder' ? item.builderPhone : null;
  return card(`
<p style="margin:0;font:700 17px/1.3 ${FONT};color:${C.ink};">${esc(item.address || 'Address not published')}${item.zip && !String(item.address || "").includes(item.zip) ? ` <span style="font-weight:400;color:${C.muted};">${esc(item.zip)}</span>` : ''}</p>
<p style="margin:4px 0 0;font:400 14px/1.45 ${FONT};color:${C.ink2};">${esc(STAGE[item.stage] || item.stage || 'Stage not mapped')} · ${esc(item.permitType || 'type not published')} · ${esc(money(item.valuation))}</p>
<p style="margin:4px 0 0;font:400 13px/1.45 ${FONT};color:${C.muted};">${officialLink(item)} · ${esc(dates)}</p>
<p style="margin:10px 0 0;font:400 15px/1.45 ${FONT};color:${C.ink};">${filedBy}</p>
${filer && filer.role === 'builder' ? callButton(phone) : ''}
${subLine}
${jobLink(links.job(item.id))}`);
}

function tradeCard(item, links, tz) {
  const gc = who(item.gc);
  return card(`
<p style="margin:0;font:700 17px/1.3 ${FONT};color:${C.ink};">${esc(item.address || 'Address not published')}${item.zip && !String(item.address || "").includes(item.zip) ? ` <span style="font-weight:400;color:${C.muted};">${esc(item.zip)}</span>` : ''}</p>
<p style="margin:4px 0 0;font:400 14px/1.45 ${FONT};color:${C.ink2};">${esc(item.permitType || 'type not published')} · ${esc(money(item.valuation))}</p>
${item.description ? `<p style="margin:4px 0 0;font:400 14px/1.45 ${FONT};color:${C.ink2};">${esc(String(item.description).slice(0, 160))}${String(item.description).length > 160 ? '…' : ''}</p>` : ''}
<p style="margin:4px 0 0;font:400 13px/1.45 ${FONT};color:${C.muted};">${officialLink(item)} · issued ${esc(fmtDate(item.issuedOn, tz) || 'date not published')} · first seen by us ${esc(fmtDate(item.firstSeenAt, tz))}</p>
<p style="margin:10px 0 0;font:400 15px/1.45 ${FONT};color:${C.ink};">Contractor: <strong>${gc || 'none on record'}</strong></p>
${item.gc && item.gc.name ? callButton(item.gc.phone) : ''}
${jobLink(links.job(item.id))}`);
}

function sectionHead(title, note) {
  return `<tr><td style="padding:24px 20px 10px;background:${C.paper};">
<h2 style="margin:0;font:700 20px/1.2 ${FONT};color:${C.ink};text-transform:uppercase;letter-spacing:0.01em;">${esc(title)}</h2>
${note ? `<p style="margin:6px 0 0;font:400 14px/1.45 ${FONT};color:${C.ink2};">${esc(note)}</p>` : ''}
</td></tr>`;
}

function moreRow(n, appUrl) {
  if (!n) return '';
  return `<tr><td style="padding:12px 20px;border-top:1px solid ${C.rule};background:${C.plate};font:400 14px/1.45 ${FONT};color:${C.ink2};">
${n} more in the app${appUrl ? `: <a href="${esc(appUrl)}" style="color:${C.accentDeep};">sign in to see them</a>` : ''}.</td></tr>`;
}

// ---------------------------------------------------------------------------
// The email

function counts(model) {
  const early = model.early ? model.early.items.length + model.early.more : 0;
  const trades = model.trades.map((t) => ({ trade: t.trade, n: t.items.length + t.more }));
  return { early, trades, total: early + trades.reduce((n, t) => n + t.n, 0) };
}

function subjectFor(model) {
  const c = counts(model);
  const parts = [];
  if (model.early) parts.push(plural(c.early, model.early.noun.one, model.early.noun.many));
  for (const t of c.trades) parts.push(`${t.n} for ${TRADE[t.trade]}`);
  const day = fmtDate(model.period.end, tzOf(model.subscription.sourceArea));
  return `${model.market.city}: ${parts.join(', ')} · ${day}`;
}

/**
 * @param {object} model   src/digest/build.js output
 * @param {object} links   { job(permitId), unsubscribe() } absolute URLs
 * @param {object} opts    { mailingAddress, appUrl, contactEmail, preview }
 * @returns {{ subject, html, text, preheader }}
 */
function renderDigest(model, links, opts = {}) {
  const sub = model.subscription;
  const tz = tzOf(sub.sourceArea);
  const m = model.market;
  const c = counts(model);
  const subject = subjectFor(model);
  const address = opts.mailingAddress || null;
  const unsubscribe = links.unsubscribe();

  const fresh = [];
  const stale = !m.lastSyncAt || (new Date(model.period.end) - new Date(m.lastSyncAt)) > 36 * 3600000;
  fresh.push(`Permits as of the last ${m.city} sync, ${fmtDateTime(m.lastSyncAt, tz)}.`);
  if (m.publicationLag) fresh.push(`${m.publicationLag}.`);
  if (model.early) fresh.push(`Filings as of the last application sync, ${fmtDateTime(m.earlyLastSyncAt, tz)}.`);
  if (model.early && m.earlyLag) fresh.push(`${m.earlyLag}.`);
  fresh.push(`This email covers what we first saw from ${fmtDateTime(model.period.start, tz)} to ${fmtDateTime(model.period.end, tz)}.`);
  const warn = m.lastSyncStatus && m.lastSyncStatus !== 'succeeded'
    ? `The latest ${m.city} sync attempt failed, so this list may be missing today's records.`
    : stale ? `The ${m.city} data is more than a day old, so this list may be missing recent records.` : null;

  const tradesWanted = model.trades.map((t) => t.trade);
  const rows = [];
  if (model.earlyUnavailable) {
    rows.push(sectionHead('Filings before issue', `${m.city} publishes issued permits only, so there are no early filings for this market.`));
  }
  if (model.early) {
    rows.push(sectionHead(model.early.title, model.early.note));
    if (!model.early.items.length) rows.push(card(`<p style="margin:0;font:400 15px/1.45 ${FONT};color:${C.ink2};">No new filings since the last email.</p>`));
    for (const it of model.early.items) rows.push(earlyCard(it, links, tz, tradesWanted.length ? tradesWanted : ['electrical', 'mechanical', 'plumbing']));
    rows.push(moreRow(model.early.more, opts.appUrl && `${opts.appUrl}/pilot/live/early.html?source=${encodeURIComponent(sub.sourceArea)}`));
  }
  for (const t of model.trades) {
    rows.push(sectionHead(`New building permits for ${TRADE[t.trade]}`,
      `Building permits first seen since the last email with no ${TRADE[t.trade]} permit on the job in the city's data yet. That does not mean nobody is hired; ask the contractor.`));
    if (!t.items.length) rows.push(card(`<p style="margin:0;font:400 15px/1.45 ${FONT};color:${C.ink2};">No new permits since the last email.</p>`));
    for (const it of t.items) rows.push(tradeCard(it, links, tz));
    rows.push(moreRow(t.more, opts.appUrl && `${opts.appUrl}/pilot/live/digest.html?source=${encodeURIComponent(sub.sourceArea)}&trade=${encodeURIComponent(t.trade)}`));
  }

  const wants = [...tradesWanted.map((t) => TRADE[t]), ...(model.early ? [model.early.title.toLowerCase()] : [])];
  const preheader = `${plural(c.total, 'new record')} in ${m.city}. Each with the business on the filing and a link to the city's record.`;
  const previewBar = opts.preview
    ? `<tr><td style="padding:8px 20px;background:${C.warnWash};font:700 13px/1.4 ${FONT};color:${C.warn};">Preview only: ${esc(opts.preview)}</td></tr>` : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${C.paper};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.paper};">
<tr><td align="center" style="padding:0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
${previewBar}
<tr><td style="padding:14px 20px;background:${C.ink};">
<span style="display:inline-block;width:12px;height:12px;background:${C.accent};vertical-align:middle;"></span>
<span style="font:700 18px/1 ${FONT};color:${C.plate};text-transform:uppercase;letter-spacing:0.02em;vertical-align:middle;">&nbsp;Giboro</span>
</td></tr>
<tr><td style="padding:20px 20px 16px;background:${C.plate};border-bottom:3px solid ${C.ink};">
<h1 style="margin:0;font:700 24px/1.2 ${FONT};color:${C.ink};">${esc(plural(c.total, 'new record'))} in ${esc(m.city)}</h1>
<p style="margin:8px 0 0;font:400 15px/1.45 ${FONT};color:${C.ink2};">${sub.company ? `For ${esc(sub.company)}: ` : ''}${esc(list(wants))}. Every record names the business on the filing where the city publishes one. Tap a number to call; you make the call.</p>
</td></tr>
<tr><td style="padding:12px 20px;background:${C.okWash};font:400 13px/1.5 ${FONT};color:${C.ink2};">${esc(fresh.join(' '))}</td></tr>
${warn ? `<tr><td style="padding:10px 20px;background:${C.warnWash};font:700 14px/1.45 ${FONT};color:${C.warn};">${esc(warn)}</td></tr>` : ''}
${rows.join('\n')}
<tr><td style="padding:24px 20px 32px;background:${C.paper};font:400 12px/1.6 ${FONT};color:${C.muted};">
<p style="margin:0 0 8px;">From public permit records${credits(m, model.early) ? `: ${esc(credits(m, model.early))}` : ''}. Giboro is not affiliated with or endorsed by any government agency. Phones are as published on permits; nobody has called to check them. Names that look like individuals are withheld.</p>
<p style="margin:0 0 8px;">You get this ${esc(sub.frequency === 'weekly' ? 'weekly' : 'daily')} email because ${esc(sub.email)} subscribed to ${esc(m.city)} ${esc(list(wants))}.
<a href="${esc(unsubscribe)}" style="color:${C.ink2};text-decoration:underline;">Unsubscribe</a> (one click, stops every Giboro email to this address).${opts.contactEmail ? ` Questions or a removal request: <a href="mailto:${esc(opts.contactEmail)}" style="color:${C.ink2};">${esc(opts.contactEmail)}</a>.` : ''}</p>
<p style="margin:0;">${address ? esc(address) : '<strong style="color:' + C.warn + ';">[Mailing address not set: MAILING_ADDRESS is required before any real send]</strong>'}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const t = [];
  t.push(`${plural(c.total, 'new record')} in ${m.city}`, '', fresh.join(' '));
  if (warn) t.push('', `NOTE: ${warn}`);
  const textItem = (it, lines) => { t.push('', ...lines.filter(Boolean), `Open: ${links.job(it.id)}`); };
  if (model.early) {
    t.push('', '', model.early.title.toUpperCase(), model.early.note || '');
    for (const it of model.early.items) {
      const f = it.filer;
      const phone = f && f.role === 'builder' && it.builderPhone ? phoneText(it.builderPhone.value) : null;
      textItem(it, [
        `${it.address || 'Address not published'} ${it.zip && !String(it.address || '').includes(it.zip) ? it.zip : ''}`.trim(),
        `${STAGE[it.stage] || it.stage} · ${it.permitType || ''} · ${money(it.valuation)} · ${it.permitNumber}`,
        f ? `Filed by ${f.name} (${ROLE[f.role] || f.role})` : it.filerWithheld ? 'Filed by an individual (name withheld)' : 'No business named on the filing',
        phone ? `Call ${phone}` : null,
      ]);
    }
    if (model.early.more) t.push('', `${model.early.more} more in the app.`);
  }
  for (const s of model.trades) {
    t.push('', '', `NEW BUILDING PERMITS FOR ${TRADE[s.trade].toUpperCase()}`);
    for (const it of s.items) {
      const phone = it.gc && it.gc.name && it.gc.phone ? phoneText(it.gc.phone.value) : null;
      textItem(it, [
        `${it.address || 'Address not published'} ${it.zip && !String(it.address || '').includes(it.zip) ? it.zip : ''}`.trim(),
        `${it.permitType || ''} · ${money(it.valuation)} · ${it.permitNumber}`,
        `Contractor: ${it.gc && it.gc.name ? it.gc.name : it.gc && it.gc.withheld ? 'An individual (name withheld)' : 'none on record'}`,
        phone ? `Call ${phone}` : null,
      ]);
    }
    if (s.more) t.push('', `${s.more} more in the app.`);
  }
  t.push('', '--',
    `From public permit records${credits(m, model.early) ? `: ${credits(m, model.early)}` : ''}. Not affiliated with or endorsed by any government agency.`,
    `Unsubscribe (stops every Giboro email to ${sub.email}): ${unsubscribe}`,
    address || '[Mailing address not set: MAILING_ADDRESS is required before any real send]');

  return { subject, html, text: t.join('\n'), preheader, total: c.total };
}

module.exports = { renderDigest, subjectFor, phoneText, esc, fmtDate, fmtDateTime, money, tzOf, credits, CREDIT, STAGE, ROLE, TRADE, C, FONT };
