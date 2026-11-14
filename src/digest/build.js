// The digest model for one subscription: what is new in its market since its
// last email, in the shape src/digest/render.js reads (ADR-20).
//
// Reads go through db/pilot_queries.js, the same queries and privacy rules as
// the pilot screens (rule 5: publicContractor / publicFiler; suppressed phones
// never come back). Nothing here selects an owner or applicant column.

const pq = require('../../db/pilot_queries.js');
const { query } = require('../../db/index.js');
const { SEGMENTS } = require('../filers.js');

const PER_SECTION = 25;
// A backfill marks a year of old records "first seen" today; these keep them
// out of the email. Leads: issued in the last 30 days. Filings: submitted in
// the last 30 days (or no submission date).
const LEAD_ISSUED_WITHIN_DAYS = 30;
const EARLY_SUBMITTED_WITHIN_DAYS = 30;
const FETCH_LIMIT = 1000;

const EARLY_COPY = {
  homes: { title: 'New home filings', one: 'new home filing', many: 'new home filings' },
  apartments: { title: 'New apartment filings', one: 'new apartment filing', many: 'new apartment filings' },
  commercial: { title: 'New commercial filings', one: 'new commercial filing', many: 'new commercial filings' },
  all: { title: 'New building filings', one: 'new building filing', many: 'new building filings' },
};

/** The subscription row as the model carries it. */
function subscriptionOf(row) {
  return {
    id: Number(row.id), email: row.email, company: row.company || null, sourceArea: row.source_area,
    trades: row.trades || [], earlySegment: row.early_segment || null, zips: row.zips || null,
    minValuation: row.min_valuation == null ? null : Number(row.min_valuation), frequency: row.frequency,
  };
}

/** Permit ids already sent to this subscription, per section. */
async function alreadySent(subscriptionId, mode) {
  const { rows } = await query('SELECT section, permit_id FROM digest_items WHERE subscription_id = $1 AND mode = $2', [subscriptionId, mode]);
  return new Set(rows.map((r) => `${r.section}:${r.permit_id}`));
}

/**
 * @param {object} row      a digest_subscriptions row
 * @param {object} opts     { mode, since: Date, until: Date, perSection }
 */
async function buildDigest(row, { mode = 'dry_run', since, until = new Date(), perSection = PER_SECTION, sent = null } = {}) {
  const sub = subscriptionOf(row);
  const f = pq.parseFilters({ source: sub.sourceArea, zips: sub.zips ? sub.zips.join(',') : '' });
  if (f.source !== sub.sourceArea) {
    throw Object.assign(new Error(`subscription ${sub.id}: ${sub.sourceArea} is not a display market`), { errorClass: 'data' });
  }
  const meta = await pq.sourceMeta(f.source);
  if (!meta) throw Object.assign(new Error(`subscription ${sub.id}: no sources row for ${f.source}`), { errorClass: 'data' });
  const seen = sent || await alreadySent(sub.id, mode);
  const fresh = (section) => (it) => !seen.has(`${section}:${it.id}`);
  const sinceIso = since ? new Date(since).toISOString() : null;
  const items = [];  // { section, permitId } for digest_items

  let early = null;
  if (sub.earlySegment && (meta.earlySources || []).length) {
    const segment = sub.earlySegment === 'all' ? null : sub.earlySegment;
    const e = await pq.listEarly(f, { days: EARLY_SUBMITTED_WITHIN_DAYS, segment, since: sinceIso, limit: FETCH_LIMIT });
    const all = e.filings.filter(fresh('early'));
    const shown = all.slice(0, perSection);
    const builderIds = [...new Set(shown.filter((x) => x.filer && x.filer.role === 'builder' && x.filer.contractorId).map((x) => x.filer.contractorId))];
    const builders = await pq.contractorsById(builderIds);
    const copy = EARLY_COPY[e.segment || (segment ? 'all' : 'all')] || EARLY_COPY.all;
    const segLabel = e.segment && SEGMENTS[e.segment] ? SEGMENTS[e.segment].label : null;
    early = {
      title: e.segmentable ? copy.title : EARLY_COPY.all.title,
      noun: e.segmentable ? { one: copy.one, many: copy.many } : { one: EARLY_COPY.all.one, many: EARLY_COPY.all.many },
      note: `Applications filed with the city and not issued yet${segLabel ? ` (${segLabel.toLowerCase()})` : ''}. `
        + 'The business that filed is named with its role: a builder, or a permit expediter filing for someone else.',
      items: shown.map((x) => {
        const b = x.filer && x.filer.role === 'builder' && x.filer.contractorId ? pq.publicContractor(builders.get(String(x.filer.contractorId))) : null;
        return {
          id: x.id, permitNumber: x.permit_number, address: x.address, zip: x.zip, permitType: x.permit_type,
          valuation: x.valuation, stage: x.stage, submittedOn: x.submittedOn, firstSeenAt: x.first_seen_at, url: x.permit_url,
          filer: x.filer ? { name: x.filer.name, role: x.filer.role, basis: x.filer.basis } : null,
          filerWithheld: x.filerWithheld, builderSubs: x.builderSubs || [],
          builderPhone: b && b.phone ? b.phone : null,
        };
      }),
      more: all.length - shown.length,
    };
    for (const it of early.items) items.push({ section: 'early', permitId: it.id });
  }

  const trades = [];
  for (const trade of sub.trades) {
    const leads = await pq.listLeads({ ...f, trade }, {
      days: LEAD_ISSUED_WITHIN_DAYS, limit: FETCH_LIMIT, minValuation: sub.minValuation, since: sinceIso, issuedWithinDays: LEAD_ISSUED_WITHIN_DAYS,
    });
    const section = `trade:${trade}`;
    const all = leads.filter(fresh(section));
    const shown = all.slice(0, perSection);
    trades.push({
      trade,
      items: shown.map((x) => ({
        id: x.id, permitNumber: x.permit_number, address: x.address, zip: x.zip, permitType: x.permit_type,
        description: x.work_description, valuation: x.valuation, issuedOn: x.issuedOn, firstSeenAt: x.first_seen_at,
        url: x.permit_url, score: x.score, gc: x.gc,
      })),
      more: all.length - shown.length,
    });
    for (const it of shown) items.push({ section, permitId: it.id });
  }

  const earlyMeta = early && meta.earlySources[0] ? await pq.sourceMeta(meta.earlySources[0]) : null;
  return {
    subscription: sub,
    market: {
      city: meta.city || meta.label, source: meta.source, attribution: meta.attribution,
      lastSyncAt: meta.lastSyncAt, lastSyncStatus: meta.lastSyncStatus, publicationLag: meta.publicationLag,
      earlyLag: meta.earlyLag, earlySource: earlyMeta ? earlyMeta.source : null, earlyLastSyncAt: earlyMeta ? earlyMeta.lastSyncAt : null,
      earlyAttribution: earlyMeta ? earlyMeta.attribution : null,
    },
    period: { start: since ? new Date(since).toISOString() : null, end: new Date(until).toISOString() },
    early,
    earlyUnavailable: Boolean(sub.earlySegment) && !early,
    trades,
    items,
  };
}

module.exports = { buildDigest, subscriptionOf, alreadySent, PER_SECTION, EARLY_COPY, LEAD_ISSUED_WITHIN_DAYS };
