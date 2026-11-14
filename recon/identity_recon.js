// Contractor identity recon (lane C): the live measurements the identity work
// is built on. Read-only against the database; prints Markdown.
//
//   node recon/identity_recon.js --architects        Miami-Dade ArchitectName profile
//   node recon/identity_recon.js --audit             200-firm entity-resolution sample
//   node recon/identity_recon.js --sunbiz=<file>     check the Sunbiz layout on a daily file
//
// Names that read like a person's are never printed whole (rule 5): only
// their initials and length, so the shape can be judged without the name.

const { normalizeName, partyKind } = require('../src/contractors.js');

const out = (s = '') => process.stdout.write(`${s}\n`);
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const cell = (v) => (v == null ? '' : String(v).replace(/\|/g, '/'));
const table = (head, rows) => {
  out(`| ${head.join(' | ')} |`);
  out(`|${head.map(() => '---').join('|')}|`);
  for (const r of rows) out(`| ${r.map(cell).join(' | ')} |`);
  out();
};

/** A name safe to print: whole if it reads as a business, initials otherwise. */
function masked(name) {
  const n = String(name ?? '').trim();
  if (!n) return '';
  if (partyKind(n) === 'business') return n;
  return `[${n.split(/\s+/).map((w) => w[0]).join('.')}. ${n.length}ch]`;
}

let db;
async function q(sql, p) {
  if (!db) {
    db = require('../db/index.js');
    db.getPool().on('connect', (c) => { c.query("SET default_transaction_read_only = on; SET statement_timeout = '300s'").catch(() => {}); });
  }
  return (await db.query(sql, p)).rows;
}

async function architects() {
  out('## Miami-Dade ArchitectName');
  out();
  const rows = await q(`
    SELECT DISTINCT ON (r.source_key) nullif(btrim(r.payload->>'ArchitectName'), '') AS a, r.payload->>'ResidentialCommercial' AS rc
      FROM raw_records r JOIN sources s ON s.id = r.source_id
     WHERE s.slug = 'miami-dade-fl'
     ORDER BY r.source_key, r.fetched_at DESC, r.id DESC`);
  const filled = rows.filter((r) => r.a);
  const kinds = { business: 0, individual: 0, unknown: 0 };
  const values = new Map();
  for (const r of filled) {
    kinds[partyKind(r.a)] += 1;
    values.set(r.a, (values.get(r.a) || 0) + 1);
  }
  out(`Permits: ${rows.length}; ArchitectName filled ${filled.length} (${pct(filled.length, rows.length)}); distinct values ${values.size}.`);
  out(`By kind (permits): business ${kinds.business} (${pct(kinds.business, filled.length)}), individual ${kinds.individual} (${pct(kinds.individual, filled.length)}), unknown ${kinds.unknown} (${pct(kinds.unknown, filled.length)}).`);
  const byNorm = new Map();
  for (const [v, n] of values) { const k = normalizeName(v); byNorm.set(k, (byNorm.get(k) || 0) + n); }
  out(`Distinct after normalising: ${byNorm.size}.`);
  out();
  const top = [...values].sort((a, b) => b[1] - a[1]).slice(0, 60);
  table(['value (people masked)', 'kind', 'permits'], top.map(([v, n]) => [masked(v), partyKind(v), n]));
  const unk = [...values].filter(([v]) => partyKind(v) === 'unknown').sort((a, b) => b[1] - a[1]).slice(0, 25);
  out('Top "unknown" values (masked unless business):');
  table(['value', 'permits'], unk.map(([v, n]) => [masked(v), n]));
  const len = {};
  for (const [v] of values) { const w = String(v).trim().split(/\s+/).length; len[w] = (len[w] || 0) + 1; }
  out(`Word counts of distinct values: ${Object.entries(len).map(([k, v]) => `${k}w ${v}`).join(', ')}.`);
  out();
  // Is it the architect (design) or does it repeat the contractor?
  const [same] = await q(`
    SELECT count(*) FILTER (WHERE upper(btrim(payload->>'ArchitectName')) = upper(btrim(payload->>'ContractorName')))::int AS same,
           count(*) FILTER (WHERE nullif(btrim(payload->>'ArchitectName'), '') IS NOT NULL)::int AS filled
      FROM raw_records r JOIN sources s ON s.id = r.source_id WHERE s.slug = 'miami-dade-fl'`);
  // Placeholders, checked by literal so no person's name is printed.
  const PH = ['NOT LISTED', 'NONE', 'N/A', 'NA', 'OWNER', 'SELF', 'TBD', 'UNKNOWN', 'NOT APPLICABLE', 'NO ARCHITECT', '.', '-', 'X'];
  const ph = PH.map((v) => [v, values.get(v) || 0]).filter(([, n]) => n);
  out(`Placeholder values: ${ph.map(([v, n]) => `"${v}" ${n}`).join(', ') || 'none of the listed literals'}.`);
  out();
  out(`ArchitectName equal to ContractorName: ${same.same} of ${same.filled} raw rows (${pct(same.same, same.filled)}).`);
  out();
}

// ---------- 200-firm resolution audit ----------

const tokens = (s) => new Set(normalizeName(s).split(' ').filter((w) => w.length > 1));
function jaccard(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let i = 0;
  for (const t of A) if (B.has(t)) i += 1;
  return i / (A.size + B.size - i);
}

async function audit() {
  out('## 200-firm entity-resolution sample');
  out();
  // 50 business entities per market, deterministic order (md5 of id), weighted
  // to firms with 2+ permits so a merge can be wrong at all.
  const sample = await q(`
    WITH m AS (
      SELECT c.id, c.identity_key, c.display_name, c.normalized_name, c.business_state, c.permit_count,
             (SELECT p.source_area FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id WHERE pp.contractor_id = c.id LIMIT 1) AS market
        FROM contractors c WHERE c.party_kind = 'business' AND c.permit_count >= 2)
    SELECT * FROM (SELECT m.*, row_number() OVER (PARTITION BY market ORDER BY md5(id::text || 'lane-c')) AS rn FROM m WHERE market IS NOT NULL) x
     WHERE rn <= 50 ORDER BY market, rn`);
  const ids = sample.map((s) => s.id);
  const aliases = await q('SELECT contractor_id, raw_name, seen_count FROM contractor_aliases WHERE contractor_id = ANY($1)', [ids]);
  const phones = await q(`SELECT contractor_id, value, seen_on_permits, shared_with_other_contractors FROM contact_points
                           WHERE kind = 'phone' AND contractor_id = ANY($1)`, [ids]);
  const lic = await q(`SELECT x.contractor_id, l.provider, l.licence_number, l.business_name, x.match_rule
                         FROM contractor_registry_licences x JOIN registry_licences l ON l.id = x.licence_id WHERE x.contractor_id = ANY($1)`, [ids]);
  let regs = [];
  try {
    regs = await q(`SELECT x.contractor_id, g.provider, g.registry_id, g.legal_name FROM contractor_registrations x
                      JOIN business_registrations g ON g.id = x.registration_id WHERE x.contractor_id = ANY($1)`, [ids]);
  } catch (err) { if (err.code !== '42P01') throw err; }
  // Split candidates: other business entities in the same state sharing a
  // phone with the sampled one, or whose name shares its first two words.
  const splitPhone = await q(`
    SELECT a.contractor_id, b.contractor_id AS other, o.display_name, o.normalized_name, o.permit_count
      FROM contact_points a JOIN contact_points b ON b.kind = 'phone' AND b.value = a.value AND b.contractor_id <> a.contractor_id
      JOIN contractors o ON o.id = b.contractor_id
     WHERE a.kind = 'phone' AND a.contractor_id = ANY($1)`, [ids]);
  const splitName = await q(`
    SELECT s.id AS contractor_id, o.id AS other, o.display_name, o.normalized_name, o.permit_count
      FROM contractors s JOIN contractors o ON o.business_state = s.business_state AND o.id <> s.id AND o.permit_count > 0
       AND split_part(o.normalized_name, ' ', 1) = split_part(s.normalized_name, ' ', 1)
       AND split_part(o.normalized_name, ' ', 2) = split_part(s.normalized_name, ' ', 2)
       AND split_part(s.normalized_name, ' ', 2) <> ''
     WHERE s.id = ANY($1)`, [ids]);
  const by = (rows) => rows.reduce((m, r) => m.set(r.contractor_id, [...(m.get(r.contractor_id) || []), r]), new Map());
  const A = by(aliases); const P = by(phones); const L = by(lic); const G = by(regs); const SP = by(splitPhone); const SN = by(splitName);

  const flags = { mergeSuspect: 0, splitSuspect: 0, sameNameTwin: 0, v5Joins: 0 };
  const unique = global.SUNBIZ_UNIQUE || new Set();
  const rows = [];
  for (const s of sample) {
    const al = (A.get(s.id) || []).sort((a, b) => b.seen_count - a.seen_count);
    const minJ = al.length > 1 ? Math.min(...al.map((a) => jaccard(a.raw_name, s.display_name))) : 1;
    const licNames = (L.get(s.id) || []).map((l) => l.business_name).filter(Boolean);
    const licJ = licNames.length ? Math.max(...licNames.map((n) => jaccard(n, s.display_name))) : null;
    const merge = minJ < 0.5 || (licJ != null && licJ < 0.34);
    const others = new Map();
    for (const o of [...(SP.get(s.id) || []), ...(SN.get(s.id) || [])]) others.set(o.other, o);
    const split = others.size > 0;
    const twins = [...others.values()].filter((o) => o.normalized_name === s.normalized_name);
    if (twins.length) flags.sameNameTwin += 1;
    const joins = twins.length > 0 && unique.has(s.normalized_name);
    if (joins) flags.v5Joins += 1;
    if (merge) flags.mergeSuspect += 1;
    if (split) flags.splitSuspect += 1;
    rows.push([s.market, s.id, s.identity_key.split(':')[0], s.display_name, s.permit_count,
      al.slice(0, 4).map((a) => `${masked(a.raw_name)}×${a.seen_count}`).join('; '),
      (P.get(s.id) || []).length,
      (L.get(s.id) || []).map((l) => `${l.provider}:${masked(l.business_name)}(${l.match_rule})`).join('; '),
      (G.get(s.id) || []).map((g) => `${g.provider}:${g.legal_name}`).join('; '),
      [...others.values()].slice(0, 4).map((o) => `#${o.other} ${masked(o.display_name)}×${o.permit_count}`).join('; '),
      `${merge ? 'M' : ''}${split ? 'S' : ''}${twins.length ? 'T' : ''}${joins ? 'J' : ''}`]);
  }
  out(`Sampled ${sample.length} business entities (2+ permits), 50 per market where available.`);
  out(`Automatic flags: possible wrong merge ${flags.mergeSuspect} (M), possible split ${flags.splitSuspect} (S). Flags are for hand review, not verdicts.`);
  out(`Same normalised name held by another entity in the state (T, a split under contractors-v4): ${flags.sameNameTwin}; `
    + `of those, one Sunbiz entity carries the name, so contractors-v5 joins them (J): ${flags.v5Joins}.`);
  const byMarket = {};
  for (const r of rows) { const m = byMarket[r[0]] || (byMarket[r[0]] = { n: 0, S: 0, T: 0, J: 0, M: 0 }); m.n += 1; for (const f of 'STJM') if (r[10].includes(f)) m[f] += 1; }
  table(['market', 'sampled', 'M', 'S', 'T', 'J'], Object.entries(byMarket).map(([k, v]) => [k, v.n, v.M, v.S, v.T, v.J]));
  out();
  table(['market', 'id', 'key', 'display name', 'permits', 'aliases', 'phones', 'licences', 'registrations', 'split candidates', 'flag'], rows);
}

// ---------- Sunbiz layout check ----------

// The corporate file layout as we read it; every field is validated below so a
// wrong offset shows up as a low pass rate rather than as bad data.
const SUNBIZ = require('../src/enrichment/sunbiz.js');

async function sunbiz(file) {
  out(`## Sunbiz layout check: ${file.split('/').pop()}`);
  out();
  const stats = { lines: 0, lengths: new Map(), checks: {} };
  const bump = (k, ok) => { const c = stats.checks[k] || (stats.checks[k] = { ok: 0, n: 0 }); c.n += 1; if (ok) c.ok += 1; };
  const types = new Map(); const statuses = new Map(); const states = new Map(); const mailStates = new Map();
  const filled = {};
  let fl = null;
  if (process.env.DATABASE_URL) {
    try { fl = new Set((await q("SELECT DISTINCT normalized_name FROM contractors WHERE business_state = 'FL' AND party_kind = 'business' AND permit_count > 0 AND length(normalized_name) >= 3")).map((r) => r.normalized_name)); } catch { fl = null; }
  }
  const cand = new Map(); // wanted name -> [{status}]
  const { lines } = require('../ingest/enrich_sunbiz.js').sftpForRecon;
  for await (const line of lines(file)) {
    stats.lines += 1;
    stats.lengths.set(line.length, (stats.lengths.get(line.length) || 0) + 1);
    const r = SUNBIZ.parseCorporateRecord(line);
    for (const [k, ok] of Object.entries(SUNBIZ.checkRecord(line))) bump(k, ok);
    if (!r) continue;
    for (const k of ['principalCity', 'principalState', 'principalZip', 'mailingCity', 'mailingState', 'mailingZip', 'filedOn', 'lastTransactionOn', 'stateOfFormation', 'reportYear']) {
      if (r[k] != null) filled[k] = (filled[k] || 0) + 1;
    }
    types.set(r.filingType, (types.get(r.filingType) || 0) + 1);
    statuses.set(r.status, (statuses.get(r.status) || 0) + 1);
    states.set(r.principalState, (states.get(r.principalState) || 0) + 1);
    mailStates.set(r.mailingState, (mailStates.get(r.mailingState) || 0) + 1);
    const key = normalizeName(r.legalName);
    if (fl && fl.has(key)) { if (!cand.has(key)) cand.set(key, []); cand.get(key).push({ registryId: r.registryId, status: r.status }); }
  }
  out(`Records: ${stats.lines}. Line lengths: ${[...stats.lengths].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, n]) => `${l} chars ×${n}`).join(', ')}.`);
  out();
  table(['check', 'pass', 'rate'], Object.entries(stats.checks).map(([k, c]) => [k, `${c.ok}/${c.n}`, pct(c.ok, c.n)]));
  out(`Filled: ${Object.entries(filled).map(([k, n]) => `${k} ${pct(n, stats.lines)}`).join(', ')}.`);
  const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k || '(blank)'} ${n}`).join(', ');
  out(`Filing types: ${top(types)}.`);
  out(`Status: ${top(statuses)}. Principal state: ${top(states)}. Mail state: ${top(mailStates)}.`);
  if (!fl) return;
  const outcome = { matched: 0, matchedActive: 0, ambiguous: 0, none: 0 };
  const unique = new Set();
  for (const n of fl) {
    const p = SUNBIZ.pickEntity(cand.get(n));
    if (p.outcome === 'matched' && p.candidates === 1) { outcome.matched += 1; unique.add(n); } else if (p.outcome === 'matched') outcome.matchedActive += 1;
    else outcome[p.outcome] += 1;
  }
  out(`Florida business contractor names: ${fl.size}. One entity: ${outcome.matched} (${pct(outcome.matched, fl.size)}); `
    + `one active of several: ${outcome.matchedActive}; ambiguous: ${outcome.ambiguous}; none: ${outcome.none} (${pct(outcome.none, fl.size)}).`);
  // What contractors-v5 rule 3 would merge, from the live contractors.
  const rows = await q(`SELECT id, identity_key, normalized_name, permit_count FROM contractors
                         WHERE business_state = 'FL' AND party_kind = 'business' AND permit_count > 0`);
  const groups = new Map();
  for (const r of rows) if (unique.has(r.normalized_name)) { if (!groups.has(r.normalized_name)) groups.set(r.normalized_name, []); groups.get(r.normalized_name).push(r); }
  const multi = [...groups.values()].filter((g) => g.length > 1);
  const absorbed = multi.reduce((a, g) => a + g.length - 1, 0);
  out(`Rule 3 simulation: ${multi.length} names join ${absorbed + multi.length} Florida entities into ${multi.length} (${absorbed} fewer of ${rows.length}); `
    + `${multi.reduce((a, g) => a + g.reduce((x, r) => x + r.permit_count, 0), 0)} permits sit on the joined entities.`);
  global.SUNBIZ_UNIQUE = unique;
  out();
}

async function raleighLicences() {
  out('## Raleigh licence fields');
  out();
  const rows = await q(`
    SELECT DISTINCT ON (r.source_key) nullif(btrim(r.payload->>'statelicnum'), '') AS st, nullif(btrim(r.payload->>'contractorlicnum'), '') AS cl,
           r.payload->>'permittype' AS type, nullif(btrim(r.payload->>'contractorcompanyname'), '') AS name
      FROM raw_records r JOIN sources s ON s.id = r.source_id WHERE s.slug = 'raleigh-nc'
     ORDER BY r.source_key, r.fetched_at DESC, r.id DESC`);
  const shape = (v) => String(v).replace(/[A-Za-z]/g, 'A').replace(/\d/g, '9');
  const tally = (f) => { const m = new Map(); for (const r of rows) if (r[f]) m.set(shape(r[f]), (m.get(shape(r[f])) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k} ${n}`).join(', '); };
  const n = rows.length; const withName = rows.filter((r) => r.name).length;
  out(`Permits ${n}; with a contractor name ${withName}. statelicnum filled ${rows.filter((r) => r.st).length} (${pct(rows.filter((r) => r.st).length, n)}), contractorlicnum ${rows.filter((r) => r.cl).length} (${pct(rows.filter((r) => r.cl).length, n)}).`);
  out(`statelicnum shapes: ${tally('st')}.`);
  out(`contractorlicnum shapes: ${tally('cl')}.`);
  const byType = new Map();
  for (const r of rows) { const t = /electric/i.test(r.type) ? 'electrical' : /plumb/i.test(r.type) ? 'plumbing' : /mechan/i.test(r.type) ? 'mechanical' : /^building/i.test(r.type) ? 'building' : 'other'; const b = byType.get(t) || { n: 0, st: 0 }; b.n += 1; if (r.st) b.st += 1; byType.set(t, b); }
  out(`statelicnum by permit type: ${[...byType].map(([t, b]) => `${t} ${pct(b.st, b.n)} of ${b.n}`).join(', ')}.`);
  const firms = new Map();
  for (const r of rows) if (r.st && r.name) { const k = r.st.toUpperCase(); if (!firms.has(k)) firms.set(k, new Set()); firms.get(k).add(normalizeName(r.name)); }
  const multi = [...firms.values()].filter((v) => v.size > 1).length;
  out(`Distinct state licence numbers: ${firms.size}; numbers seen with 2+ different normalised names: ${multi}.`);
  out();
}

async function accountMarks() {
  out('## Account marks in contractor names');
  out();
  const [r] = await q(String.raw`SELECT count(*) FILTER (WHERE display_name ~* '\*+\s*main') ::int AS marked,
       count(*)::int AS total FROM contractors WHERE permit_count > 0`);
  out(`Contractors whose name carries an AMANDA account mark ("*MAIN*"): ${r.marked} of ${r.total}.`);
  out();
}

async function main() {
  const arg = (n) => { const a = process.argv.find((x) => x === `--${n}` || x.startsWith(`--${n}=`)); return a ? (a.split('=')[1] ?? true) : null; };
  try {
    if (arg('sunbiz')) await sunbiz(arg('sunbiz'));
    if (arg('architects')) await architects();
    if (arg('audit')) { await raleighLicences(); await accountMarks(); await audit(); }
  } finally {
    if (db) await db.close();
  }
}

if (require.main === module) main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });

module.exports = { masked, jaccard };
