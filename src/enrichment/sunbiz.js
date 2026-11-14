// Florida Sunbiz (Division of Corporations) corporate records as legal-entity
// keys for Florida contractor businesses (lane C, ADR-23 sprint 2). The Texas
// Comptroller does the same for Texas (src/enrichment/registrations.js).
//
// Source: the Division's free public SFTP downloads, sftp.floridados.gov,
// user "Public" (dos.fl.gov/sunbiz/other-services/data-downloads/, read
// 2026-11-14). Quarterly: doc/Quarterly/Cor/cordata.zip (1.79 GB on 2026-11-14), every record on file.
// Daily: doc/cor/yyyymmddc.txt, the filings entered that work day.
//
// Layout: fixed width, 1440 characters, from the Division's "Corporation Data
// File Structure" page (dos.fl.gov/sunbiz/other-services/data-downloads/
// corporate-data-file/file-structure/, read 2026-11-14). Positions below are
// 1-based as published. checkRecord() validates every field we read, so a
// shifted layout shows up as a failed check, never as stored data.
//
// Rule 5: everything from position 545 on is the registered agent and up to
// six officers, who are mostly people. It is never sliced, parsed or stored.
// The FEI number is not stored either: nothing else we hold carries it.
//
// Matching (pure, like the Comptroller's):
//   - exact normalised name (src/contractors.js normalizeName), one Florida
//     entity with that name                      -> matched, name_state 0.80
//   - several entities, exactly one active       -> matched, name_state_active 0.75
//   - several active                             -> ambiguous, no link (rule 1)
//   - none                                       -> none

const { normalizeName } = require('../contractors.js');

const PROVIDER = {
  slug: 'fl-sunbiz',
  label: 'Florida Department of State, Division of Corporations (Sunbiz)',
  host: 'sftp.floridados.gov',
  dailyDir: 'doc/cor',
  quarterlyFile: 'doc/Quarterly/Cor/cordata.zip',
  recordLength: 1440,
};

// [1-based start, length], as published. Nothing past position 544.
const LAYOUT = {
  number: [1, 12],
  name: [13, 192],
  status: [205, 1],
  filingType: [206, 15],
  principalCity: [305, 28],
  principalState: [333, 2],
  principalZip: [335, 10],
  principalCountry: [345, 2],
  mailCity: [431, 28],
  mailState: [459, 2],
  mailZip: [461, 10],
  fileDate: [473, 8],
  lastTransactionDate: [496, 8],
  stateCountry: [504, 2],
  reportYear1: [506, 4],
};
const PRIVATE_FROM = 545;

// Filing type codes as listed on the file-structure page.
const FILING_TYPES = new Set(['DOMP', 'DOMNP', 'FORP', 'FORNP', 'DOMLP', 'FORLP', 'FLAL', 'FORL', 'NPREG', 'TRUST', 'AGENT']);

const slice = (line, [start, len]) => {
  if (start + len - 1 >= PRIVATE_FROM) throw new Error('refusing to read the agent and officer positions');
  return line.substr(start - 1, len).trim();
};

/** "MMDDYYYY" -> "YYYY-MM-DD", else null. */
function mmddyyyy(v) {
  const m = String(v ?? '').match(/^(\d{2})(\d{2})(\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[1]}-${m[2]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** Field-by-field validation of one line, for the layout check. */
function checkRecord(line) {
  const get = (k) => slice(line, LAYOUT[k]);
  const date = (k) => { const v = get(k); return v === '' || mmddyyyy(v) !== null; };
  return {
    length1440: line.length === PROVIDER.recordLength,
    number: /^[A-Z0-9]{6,12}$/.test(get('number')),
    name: get('name').length > 0,
    status: /^[AI]$/.test(get('status')),
    filingType: FILING_TYPES.has(get('filingType')),
    principalState: /^([A-Z]{2})?$/.test(get('principalState')),
    principalZip: /^(\d{5}(-?\d{4})?)?$/.test(get('principalZip').replace(/\s+/g, '')),
    fileDate: mmddyyyy(get('fileDate')) !== null,
    lastTransactionDate: date('lastTransactionDate'),
    reportYear1: /^(\d{4})?$/.test(get('reportYear1')),
  };
}

/** One line -> the business fields we keep, or null if it is not a usable record. */
function parseCorporateRecord(line) {
  if (typeof line !== 'string' || line.length < PRIVATE_FROM - 1) return null;
  const get = (k) => slice(line, LAYOUT[k]) || null;
  const number = get('number');
  const name = get('name');
  if (!number || !/^[A-Z0-9]{6,12}$/.test(number) || !name) return null;
  const zip = (v) => { const z = String(v || '').replace(/\D/g, ''); return z.length >= 5 ? z.slice(0, 5) : null; };
  const year = get('reportYear1');
  return {
    registryId: number,
    legalName: name,
    status: get('status'),                     // A or I, as published
    filingType: get('filingType'),             // DOMP, FLAL, ... as published
    principalCity: get('principalCity'),
    principalState: get('principalState'),
    principalZip: zip(get('principalZip')),
    mailingCity: get('mailCity'),
    mailingState: get('mailState'),
    mailingZip: zip(get('mailZip')),
    filedOn: mmddyyyy(get('fileDate')),
    lastTransactionOn: mmddyyyy(get('lastTransactionDate')),
    stateOfFormation: get('stateCountry'),
    reportYear: year && /^\d{4}$/.test(year) ? Number(year) : null,
  };
}

/** The date in a daily file's name ("20261113c.txt"), or null. */
function dailyFileDate(name) {
  const m = String(name || '').match(/(?:^|\/)(\d{4})(\d{2})(\d{2})c\.txt$/i);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * All Sunbiz entities that share one normalised contractor name -> outcome.
 * @param {{registryId, status}[]} candidates
 */
function pickEntity(candidates) {
  const list = [...new Map((candidates || []).map((c) => [c.registryId, c])).values()];
  if (list.length === 1) return { outcome: 'matched', registryId: list[0].registryId, rule: 'name_state', confidence: 0.8, candidates: 1 };
  if (!list.length) return { outcome: 'none', registryId: null, candidates: 0 };
  const active = list.filter((c) => c.status === 'A');
  if (active.length === 1) return { outcome: 'matched', registryId: active[0].registryId, rule: 'name_state_active', confidence: 0.75, candidates: list.length };
  return { outcome: 'ambiguous', registryId: null, candidates: list.length };
}

/**
 * Streams lines and keeps the records whose normalised name is wanted, or
 * whose id is already held (a daily update to an entity we track).
 */
function selector({ names, ids = new Set() }) {
  return (line) => {
    const r = parseCorporateRecord(line);
    if (!r) return null;
    const key = normalizeName(r.legalName);
    if (names.has(key) || ids.has(r.registryId)) return { ...r, nameKey: key };
    return null;
  };
}

module.exports = { PROVIDER, LAYOUT, FILING_TYPES, mmddyyyy, checkRecord, parseCorporateRecord, dailyFileDate, pickEntity, selector };
