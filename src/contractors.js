// Contractor resolution (ADR-12): which permits belong to the same business,
// and which business is the GC and which the sub on a job.
//
// Deterministic and conservative. A wrong merge invents a company and corrupts
// every count built on it; a missed merge only splits one firm into two rows.
// So the rules only merge on strong keys:
//   1. licence number (Miami-Dade publishes ContractorNumber)        conf 0.95
//   2. exact normalized business name within one state              conf 0.80
// Near-miss spellings ("Radiant Plumbing & AC" vs "... and Air Conditioning")
// stay separate. A phone is evidence attached to a contractor, never a merge
// key: 49 Austin phones are listed under 2+ different company names.
//
// Pure functions only; ingest/resolve.js does the database work.

const { SOURCES } = require('./sources.js');

const RESOLVER_VERSION = 'contractors-v3';

const NON_CONTRACTORS = new Set(['owner', 'owner builder', 'self', 'homeowner', 'na', 'n a', 'none', 'tbd', 'unknown', 'owner owner']);

// Legal-form words dropped for the identity key, so "Acme Builders, LLC" and
// "ACME BUILDERS INC" are one name. Trade words are kept: "Acme Plumbing" and
// "Acme Electric" are different firms. Place words ("of Texas", "TX") are
// kept too (contractors-v2, ADR-18): stripping them merged different legal
// entities, e.g. "Meritage Homes of Texas LLC" with "Meritage Homes
// Corporation" and "Pool Builders of Texas" with "Pool Builders Inc".
const LEGAL_SUFFIXES = new Set(['llc', 'l l c', 'inc', 'incorporated', 'co', 'corp', 'corporation', 'company', 'ltd', 'limited',
  'lp', 'llp', 'pllc', 'pc', 'pa', 'plc', 'dba', 'the']);

const BUSINESS_WORDS = /\b(llc|inc|corp|co|company|ltd|lp|llp|pllc|services?|construction|constructors?|contracting|contractors?|builders?|building|homes?|plumbing|electric(al)?|mechanical|air|hvac|heating|cooling|roofing|solar|pools?|remodel(ing)?|renovations?|restoration|development|group|enterprises?|industries|systems|solutions|properties|design|energy|power|fire|sprinklers?|ac|a\/c|conditioning|windows?|doors?|fence|concrete|paving|landscap\w*|drywall|painting|flooring|tile|cabinets?|glass|steel|iron|welding|demolition|excavation|utilities|engineering|technologies|tech|supply|partners|associates|management|holdings|realty|international|national|america|usa)\b/i;

function cleanText(raw) {
  return String(raw ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\./g, '')          // "L.L.C." -> "llc"
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Identity form of a business name: lowercased, punctuation and legal forms removed. */
function normalizeName(raw) {
  const words = cleanText(raw).split(' ').filter(Boolean);
  // Strip legal forms from the end only ("Co" mid-name can be meaningful),
  // and a leading "the".
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  if (words.length > 1 && words[0] === 'the') words.shift();
  return words.join(' ');
}

function isOwnerBuilder(raw) {
  const c = cleanText(raw);
  return !c || NON_CONTRACTORS.has(c) || /^owner\b/.test(c) || /\bhomeowner\b/.test(c);
}

/**
 * business | individual | unknown, from the name alone. "Individual" means it
 * reads like a person's name (two or three plain words, no business word), so
 * its phone may be a personal phone and is hidden (CLAUDE.md rule 5).
 */
// contractors-v3 (owner's approval 2026-11-14, ADR-22): trade and firm words
// seen on real Austin businesses that the first list missed ("Bluebonnet
// Foundation Repair", "Waterloo Permits", "Martha Nolan Interiors"). Kept to
// words that are not common first names or surnames, so a plain first and
// last name ("Austin Smith", "Taylor Morrison") still reads as a person.
const MORE_BUSINESS_WORDS = /\b(repairs?|foundations?|interiors?|projects|architects?|architecture|studios?|works|homebuilders?|builds|permits?|permitting|expedit\w*|improvements?|maintenance|installations?|installers?|plumbers|electricians|lighting|carpentry|masonry|framing|insulation|gutters|siding|irrigation|septic|drilling|surveying|consulting|consultants?|outdoors?|landscapes?|decks|patios|garages|exteriors?|millwork|cabinetry|countertops|plastering|stucco|waterproofing|remodelers?|renovators?|craftsmen|contractor)\b/i;
// "Renewal by Andersen", "Smith Plumbing of Texas": a person's name has no "by" or "of".
const CONNECTOR_WORDS = /\s(by|of)\s/i;

function partyKind(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return 'unknown';
  if (BUSINESS_WORDS.test(name) || MORE_BUSINESS_WORDS.test(name) || CONNECTOR_WORDS.test(name) || /\d/.test(name)) return 'business';
  const words = cleanText(name).split(' ').filter(Boolean);
  if (words.length >= 2 && words.length <= 4 && words.every((w) => /^[a-z]+$/.test(w))) return 'individual';
  return 'unknown';
}

/** Rule 5 display policy for a contact found on a contractor of this kind. */
function displayPolicy(kind) {
  if (kind === 'business') return 'show';
  if (kind === 'individual') return 'hide';
  return 'review';
}

/** E.164 for a US number, or null. Rejects impossible area and exchange codes. */
function toE164(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10) return null;
  if (/^[01]/.test(d) || /^\d{3}[01]/.test(d)) return null;
  if (/^(\d)\1{9}$/.test(d)) return null; // 5555555555 and friends
  return `+1${d}`;
}

function cleanLicence(raw) {
  const v = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!v || /^0+$/.test(v) || v === 'NA' || v === 'N/A' || v === 'NONE') return null;
  return v;
}

/**
 * The identity a contractor party resolves to, or null if it can't be
 * resolved (no usable name and no licence).
 */
function identityFor({ name, licence, state }) {
  const lic = cleanLicence(licence);
  if (lic && state) return { key: `lic:${state}:${lic}`, rule: 'licence', confidence: 0.95 };
  const n = normalizeName(name);
  if (n && n.length >= 3 && state) return { key: `name:${state}:${n}`, rule: 'name_state', confidence: 0.8 };
  return null;
}

// ---------- per-source extraction from raw records ----------

const day = (v) => {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v).length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const str = (v) => String(v ?? '').trim();

/**
 * Builds the extractor for one source from its `parties` block in
 * src/sources.js (the connector template, ADR-14). The extractor reads the
 * fields resolution needs from one raw payload. `groupKey` ties a building
 * permit to its trade permits:
 *   job.kind 'numberBase'  - the permit number without its type suffix
 *                            (Austin: "2026-104544 BP" and "... EP")
 *   job.kind 'masterField' - a parent-permit field; values matching job.none
 *                            mean "no parent", so the permit is its own group
 *                            (Miami-Dade: MasterPermitNumber, "0000000000";
 *                            City of Miami: ApplicationNumber; Raleigh: pin)
 * The type code comes from typeField, or from the permit number: a trailing
 * " XX" (typeFromNumberSuffix, Austin) or a regex's first group
 * (typeFromNumber, City of Miami "BD26009606001E001" -> "E"). The trade is
 * tradeByType[code], else the first tradeByPattern [regex, trade] that matches
 * (Raleigh "DSINSP - Electrical (Residential)").
 */
function extractorFor(spec) {
  const none = spec.job && spec.job.none ? new RegExp(spec.job.none) : null;
  const fromNumber = spec.typeFromNumber ? new RegExp(spec.typeFromNumber) : null;
  const patterns = (spec.tradeByPattern || []).map(([re, trade]) => [new RegExp(re, 'i'), trade]);
  const building = new Set((spec.buildingTypes || []).map((t) => t.toUpperCase()));
  const tradeOf = (code) => (spec.tradeByType || {})[code] || (code && (patterns.find(([re]) => re.test(code)) || [])[1]) || null;
  return (p) => {
    const permitNumber = str(p[spec.number]);
    const typeCode = str(spec.typeField && p[spec.typeField]).toUpperCase()
      || (spec.typeFromNumberSuffix ? (permitNumber.match(/\s([A-Z]{2,3})$/) || [])[1] : null)
      || (fromNumber ? (permitNumber.match(fromNumber) || [])[1] : null) || null;
    let groupKey = null;
    if (spec.job && spec.job.kind === 'numberBase') groupKey = permitNumber.replace(/\s+[A-Z]{2,3}$/, '') || null;
    else if (spec.job && spec.job.kind === 'masterField') {
      const master = str(p[spec.job.field]);
      groupKey = master && !(none && none.test(master)) ? master : permitNumber || null;
    }
    const field = (f) => (f ? p[f] || null : null);
    return {
      permitNumber,
      typeCode,
      isBuilding: building.has(typeCode),
      trade: tradeOf(typeCode),
      groupKey,
      issuedOn: day(p[spec.issued]),
      name: field(spec.name),
      phone: field(spec.phone),
      licence: field(spec.licence),
      rawTrade: field(spec.rawTrade),
      city: field(spec.city),
      state: spec.state,
    };
  };
}

// One extractor per source that declares a `parties` block.
const EXTRACTORS = Object.fromEntries(Object.entries(SOURCES)
  .filter(([, src]) => src.parties)
  .map(([slug, src]) => [slug, extractorFor(src.parties)]));

/**
 * Resolves a batch of extracted parties. Returns contractors keyed by identity,
 * one party per permit, and contact points, all as plain objects.
 *
 * @param {{sourceSlug: string, permitNumber: string, name, phone, licence, state, city, issuedOn, rawTrade, trade}[]} parties
 */
function resolveParties(parties) {
  const contractors = new Map(); // key -> contractor
  const resolved = [];
  for (const party of parties) {
    if (isOwnerBuilder(party.name) && !cleanLicence(party.licence)) {
      resolved.push({ ...party, identityKey: null, rule: 'owner_builder', confidence: null });
      continue;
    }
    const id = identityFor(party);
    if (!id) { resolved.push({ ...party, identityKey: null, rule: 'unresolved', confidence: null }); continue; }
    let c = contractors.get(id.key);
    if (!c) {
      c = { identityKey: id.key, names: new Map(), phones: new Map(), licences: new Set(), trades: new Map(), cities: new Map(),
        state: party.state, first: null, last: null, permits: 0 };
      contractors.set(id.key, c);
    }
    c.permits += 1;
    const nameKey = `${party.sourceSlug}\u0000${String(party.name ?? '').trim()}`;
    if (party.name) c.names.set(nameKey, (c.names.get(nameKey) || 0) + 1);
    const phone = toE164(party.phone);
    if (phone) {
      const prev = c.phones.get(phone);
      if (!prev) c.phones.set(phone, { count: 1, lastOn: party.issuedOn, lastRef: party.permitNumber, source: party.sourceSlug });
      else {
        prev.count += 1;
        if (party.issuedOn && (!prev.lastOn || party.issuedOn > prev.lastOn)) Object.assign(prev, { lastOn: party.issuedOn, lastRef: party.permitNumber });
      }
    }
    const lic = cleanLicence(party.licence);
    if (lic) c.licences.add(lic);
    const trade = party.rawTrade || party.trade;
    if (trade) c.trades.set(trade, (c.trades.get(trade) || 0) + 1);
    if (party.city) c.cities.set(String(party.city).trim().toUpperCase(), (c.cities.get(String(party.city).trim().toUpperCase()) || 0) + 1);
    if (party.issuedOn) {
      if (!c.first || party.issuedOn < c.first) c.first = party.issuedOn;
      if (!c.last || party.issuedOn > c.last) c.last = party.issuedOn;
    }
    resolved.push({ ...party, identityKey: id.key, rule: id.rule, confidence: id.confidence });
  }

  // How many contractors list each phone: a phone shared across firms is a
  // weaker contact (an expediter's or a shared office line).
  const phoneOwners = new Map();
  for (const c of contractors.values()) for (const p of c.phones.keys()) phoneOwners.set(p, (phoneOwners.get(p) || 0) + 1);

  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] ?? null;
  const out = [];
  for (const c of contractors.values()) {
    const displayName = top(new Map([...c.names].map(([k, v]) => [k.split('\u0000')[1], v]))) || c.identityKey.split(':').slice(2).join(':');
    const kind = partyKind(displayName);
    out.push({
      identityKey: c.identityKey,
      displayName,
      normalizedName: normalizeName(displayName),
      partyKind: kind,
      primaryTrade: top(c.trades),
      businessCity: top(c.cities),
      businessState: c.state,
      firstPermitOn: c.first,
      lastPermitOn: c.last,
      permitCount: c.permits,
      aliases: [...c.names].map(([k, n]) => { const [source, raw] = k.split('\u0000'); return { source, raw, n }; }),
      licences: [...c.licences],
      contacts: [...c.phones].map(([value, p]) => ({
        kind: 'phone', value, partyKind: kind, displayPolicy: displayPolicy(kind), source: `permit:${p.source}`,
        sourceRef: p.lastRef, seenOnPermits: p.count, lastSeenOn: p.lastOn,
        sharedWithOtherContractors: phoneOwners.get(value) - 1,
        // "Corroborated" needs independent support (DATA_MODEL.md): 3+ permits
        // for this contractor and not shared with another firm.
        verification: p.count >= 3 && phoneOwners.get(value) === 1 ? 'corroborated' : 'unverified',
      })),
    });
  }
  return { contractors: out, parties: resolved };
}

/**
 * GC -> sub links. Within a group (one building job), the building permit's
 * contractor is the GC and each trade permit's contractor is a sub. A GC doing
 * its own trade work is not a relationship.
 *
 * @param {{groupKey, isBuilding, trade, identityKey, issuedOn, sourceSlug}[]} parties resolved parties
 */
function buildRelationships(parties) {
  const groups = new Map();
  for (const p of parties) {
    if (!p.groupKey || !p.identityKey) continue;
    const k = `${p.sourceSlug}\u0000${p.groupKey}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const rel = new Map();
  for (const members of groups.values()) {
    const gcs = [...new Set(members.filter((m) => m.isBuilding).map((m) => m.identityKey))];
    if (gcs.length !== 1) continue; // no BP, or two different GCs: ambiguous, skip
    const gc = gcs[0];
    const seen = new Set();
    for (const m of members) {
      if (!m.trade || m.identityKey === gc) continue;
      const k = `${gc}\u0000${m.identityKey}\u0000${m.trade}`;
      if (seen.has(k)) continue; // one job counts once per sub and trade
      seen.add(k);
      const r = rel.get(k) || { gcKey: gc, subKey: m.identityKey, trade: m.trade, jobs: 0, first: null, last: null };
      r.jobs += 1;
      if (m.issuedOn) {
        if (!r.first || m.issuedOn < r.first) r.first = m.issuedOn;
        if (!r.last || m.issuedOn > r.last) r.last = m.issuedOn;
      }
      rel.set(k, r);
    }
  }
  return [...rel.values()];
}

module.exports = {
  RESOLVER_VERSION, EXTRACTORS, extractorFor,
  normalizeName, isOwnerBuilder, partyKind, displayPolicy, toE164, cleanLicence, identityFor,
  resolveParties, buildRelationships,
};
