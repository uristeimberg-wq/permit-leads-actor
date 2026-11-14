// Business registrations (ADR-23 sprint 2): ties a Texas contractor business
// to its legal entity in the Comptroller's franchise-tax records (taxpayer
// id, Secretary of State file number, right to transact). Licences cover only
// some trades (Texas has no general-contractor licence, ADR-14); every LLC,
// corporation and LP that does business in Texas is in this file.
//
// Pure functions; ingest/enrich_registrations.js does the I/O.
//
// Rules:
//   - Match on the exact normalised name (src/contractors.js normalizeName),
//     and only when exactly one taxpayer has it. Two taxpayers with the same
//     name ("IES Residential, Inc." and "IES Residential Inc") are ambiguous:
//     no match rather than a guess (rule 1).
//   - A longer legal name that merely starts with ours ("Christianson
//     Plumbing" -> "CHRISTIANSON PLUMBING & A/C") is recorded as a candidate,
//     not a match.
//   - Only business facts are kept. Officers and the registered agent are
//     people and are never stored (rule 5); neither is the street address.

const { normalizeName } = require('../contractors.js');

const PROVIDER = {
  slug: 'tx-comptroller',
  label: 'Texas Comptroller of Public Accounts, franchise tax',
  base: 'https://api.comptroller.texas.gov/public-data/v1/public',
  // 429s came after three requests 0.6 s apart (probe 2026-11-14), with no
  // rate-limit headers to read.
  minIntervalMs: 1500,
  // A match is re-read monthly (status changes); no match, quarterly.
  refreshDays: { matched: 30, none: 90, ambiguous: 90, prefix: 90, error: 1 },
};

/**
 * What to send as `name`: the normalised name up to its first "and", so that
 * "Protex Plumbing & Mechanical" and "Protex Plumbing and Mechanical" both
 * find "PROTEX PLUMBING & MECHANICAL, LP" (the API matches the start of the
 * legal name, punctuation included). Results are then compared in full.
 */
function searchText(normalized) {
  const n = String(normalized || '').trim();
  if (!n) return null;
  const words = n.split(' ');
  const cut = words.indexOf('and');
  const head = (cut > 0 ? words.slice(0, cut) : words).join(' ');
  const q = head.length >= 4 ? head : n;
  return q.slice(0, 50).toUpperCase();
}

/**
 * The search results for one contractor name -> one outcome:
 *   matched   exactly one taxpayer whose normalised legal name equals ours
 *   ambiguous more than one such taxpayer
 *   prefix    none equal, exactly one starts with ours (a candidate only)
 *   none      nothing usable
 */
function pickMatch(normalized, body) {
  const list = (body && Array.isArray(body.data)) ? body.data : [];
  const exact = [...new Map(list.filter((r) => normalizeName(r.name) === normalized).map((r) => [r.taxpayerId, r])).values()];
  if (exact.length === 1) return { outcome: 'matched', taxpayerId: exact[0].taxpayerId, candidates: list.length };
  if (exact.length > 1) return { outcome: 'ambiguous', taxpayerId: null, candidates: exact.length };
  const pre = list.filter((r) => normalizeName(r.name).startsWith(`${normalized} `));
  if (pre.length === 1) return { outcome: 'prefix', taxpayerId: pre[0].taxpayerId, candidates: list.length };
  return { outcome: 'none', taxpayerId: null, candidates: list.length };
}

const text = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

/** "MM/DD/YYYY" -> "YYYY-MM-DD", else null. */
function usDate(v) {
  const m = String(v ?? '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[1]}-${m[2]}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
}

/** A franchise-tax detail response -> a business_registrations row (business fields only). */
function mapDetail(body) {
  const d = body && body.data;
  if (!d || !text(d.taxpayerId)) return null;
  return {
    registryId: text(d.taxpayerId),
    legalName: text(d.name),
    dbaName: typeof d.dbaName === 'string' ? text(d.dbaName) : null,
    sosFileNumber: text(d.sosFileNumber),
    stateOfFormation: text(d.stateOfFormation),
    sosStatus: text(d.sosRegistrationStatus),
    rightToTransact: text(d.rightToTransactTX),
    sosRegisteredOn: usDate(d.effectiveSosRegistrationDate),
    reportYear: /^\d{4}$/.test(String(d.reportYear || '').trim()) ? Number(d.reportYear) : null,
    mailingCity: text(d.mailingAddressCity),
    mailingState: text(d.mailingAddressState),
    mailingZip: text(d.mailingAddressZip) ? String(d.mailingAddressZip).trim().slice(0, 5) : null,
  };
}

module.exports = { PROVIDER, searchText, pickMatch, mapDetail, usDate };
