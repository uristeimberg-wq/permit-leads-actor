// Licence verification (ADR-15 item 1). State licence files confirm that a
// contractor is a licensed business and when its licence expires. They are
// not a phone source: permits already carry phones (91% Austin, 82%
// Miami-Dade), Florida's files have none, and Texas only publishes a business
// phone for electrical contractors.
//
// Pure parsing and matching; ingest/enrich_licences.js does the I/O.
// Nothing here guesses: DBPR status and class codes are kept as published
// (their meanings come from DBPR, not from us), and dates that are not
// MM/DD/YYYY are null.

const { normalizeName, toE164 } = require('../contractors.js');

const PROVIDERS = {
  'fl-dbpr': {
    label: 'Florida DBPR licence extracts',
    state: 'FL',
    files: [
      'https://www2.myfloridalicense.com/sto/file_download/extracts//CONSTRUCTIONLICENSE_1.csv',
      'https://www2.myfloridalicense.com/sto/file_download/extracts/lic08el.csv',
    ],
  },
  'tx-tdlr': {
    label: 'Texas Department of Licensing and Regulation',
    state: 'TX',
    endpoint: 'https://data.texas.gov/resource/7358-krk7.json',
    // Business licences only. A/C rows carry no phone or address; their
    // owner_name is the individual licensee and is never requested.
    types: ['Electrical Contractor', 'Electrical Sign Contractor', 'A/C Contractor'],
    // Only these types publish a business phone (business = owner on every row).
    phoneTypes: ['Electrical Contractor', 'Electrical Sign Contractor'],
    columns: ['license_type', 'license_subtype', 'license_number', 'license_expiration_date_mmddccyy',
      'business_name', 'business_city_state_zip', 'business_county', 'business_telephone'],
  },
};

/** "MM/DD/YYYY" -> "YYYY-MM-DD"; anything else -> null. */
function usDate(v) {
  const m = String(v ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
}

/**
 * A Florida licence number in one comparable form: letters plus the number
 * without leading zeros, so "CGC061097" meets "CGC61097" (95.9% of Miami-Dade
 * permits match this way). Digit-first shapes ("12AB0001") are kept whole.
 */
function normalizeFlLicence(v) {
  const s = String(v ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (!s || /^0+$/.test(s)) return null;
  const m = s.match(/^([A-Z]+)0*(\d+)$/);
  if (m) return `${m[1]}${m[2]}`;
  return /^[A-Z0-9]+$/.test(s) && /[A-Z]/.test(s) ? s : null;
}

/** One CSV line (quote/comma, no embedded newlines) -> fields. */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/**
 * One DBPR extract row (22 fields, no header; layout in docs/DATA_SOURCES.md)
 * -> a licence. The licensee name may be a person, so it is stored for
 * matching only and never displayed.
 */
function mapDbprRow(f) {
  if (!f || f.length < 21) return null;
  const licenceKey = normalizeFlLicence(f[20]) || null;
  if (!licenceKey) return null;
  return {
    licenceKey,
    licenceNumber: f[20].toUpperCase(),
    licenceType: f[1] || null, // occupation code as published (CGC, CCC, EC, ...)
    classCode: f[4] || null,
    businessName: f[3] || null, // DBA
    holderName: f[2] || null, // may be an individual: never displayed
    city: f[8] || null,
    state: f[9] || null,
    primaryStatus: f[13] || null,
    secondaryStatus: f[14] || null,
    expiresOn: usDate(f[17]),
    phone: null,
  };
}

/** One TDLR row (only the business columns are requested) -> a licence. */
function mapTdlrRow(r, provider = PROVIDERS['tx-tdlr']) {
  if (!r || !provider.types.includes(r.license_type) || !r.license_number) return null;
  const number = String(r.license_number).trim();
  const cityLine = String(r.business_city_state_zip || '').trim();
  return {
    licenceKey: `${r.license_type}:${number}`,
    licenceNumber: number,
    licenceType: r.license_type,
    classCode: r.license_subtype || null,
    businessName: r.business_name || null,
    holderName: null,
    city: (cityLine.match(/^(.*?)\s+[A-Z]{2}\s+\d{5}/) || [])[1] || null,
    state: 'TX',
    primaryStatus: null,
    secondaryStatus: null,
    expiresOn: usDate(r.license_expiration_date_mmddccyy),
    phone: provider.phoneTypes.includes(r.license_type) ? toE164(r.business_telephone) : null,
  };
}

/**
 * Links our contractors to licences.
 * @param {{id, identityKey, normalizedName, state, partyKind, phones: string[]}[]} contractors
 * @param {object[]} licences mapped rows from one provider
 * @returns {{contractorId, licenceKey, rule, confidence}[]}
 *   licence: the permit's own licence number (FL)              0.95
 *   phone:   the contractor's shown phone is the licence's      0.90
 *   name_state: same normalized business name, same state      0.80
 */
function matchLicences(contractors, licences, state) {
  const byKey = new Map(licences.map((l) => [l.licenceKey, l]));
  const byPhone = new Map();
  const byName = new Map();
  for (const l of licences) {
    if (l.phone) byPhone.set(l.phone, [...(byPhone.get(l.phone) || []), l]);
    const n = normalizeName(l.businessName);
    if (n && n.length >= 3) byName.set(n, [...(byName.get(n) || []), l]);
  }
  const out = [];
  const seen = new Set();
  const add = (c, l, rule, confidence) => {
    const k = `${c.id}\u0000${l.licenceKey}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ contractorId: c.id, licenceKey: l.licenceKey, rule, confidence });
  };
  for (const c of contractors) {
    if (c.state !== state) continue;
    const lic = c.identityKey.startsWith(`lic:${state}:`) ? normalizeFlLicence(c.identityKey.split(':').slice(2).join(':')) : null;
    if (lic && byKey.has(lic)) add(c, byKey.get(lic), 'licence', 0.95);
    if (c.partyKind !== 'business') continue; // names and phones of people are not matched (rule 5)
    for (const p of c.phones || []) for (const l of byPhone.get(p) || []) add(c, l, 'phone', 0.9);
    // A name shared by several licences is ambiguous: no match rather than a guess.
    const named = byName.get(c.normalizedName) || [];
    if (named.length === 1) add(c, named[0], 'name_state', 0.8);
  }
  return out;
}

module.exports = { PROVIDERS, usDate, normalizeFlLicence, parseCsvLine, mapDbprRow, mapTdlrRow, matchLicences };
