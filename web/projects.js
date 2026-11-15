// Projects: permits that belong to one job, grouped for the Leads screen.
//
// Links, strongest first (web/project_stages.js holds the tunables):
//   1. the same official job number (Austin permit-number base, Miami-Dade
//      master permit, City of Miami application)          basis 'permit number'
//   2. "Ref: <number> BP" written inside a description    basis 'ref in description'
//   3. the same address with any BLDG tail removed, filed within a year of
//      each other; and Raleigh's parcel PIN                 basis 'same address'
// Link 3 is an inference (docs/DATA_TRUST_AUDIT.md class C): it is used only
// when SHOW_INFERENCES=1, like the construction-stage label. Without it, a
// project is what the official numbers say and nothing more.
//
// The rows come from db/queries.js projectRows/projectCandidates, already
// redacted (rule 5): a phone here is a business contact, never an owner's.

const rules = require('./project_stages.js');

const DAY = 86400000;
const ODD_VALUE = 1e9;

/** "2501 BRYAN ST BLDG 3, AUSTIN TX" -> "2501 BRYAN ST|78702". Mirrors ADDRESS_KEY_SQL. */
function addressKey(p) {
  const street = String(p.address || '').split(',')[0].toUpperCase().replace(/\s+/g, ' ').trim();
  const base = street.replace(/\s+(BLDG|BUILDING)\b.*$/, '').trim();
  return base ? `${base}|${String(p.zip || p.city || '').toUpperCase()}` : null;
}
/** The BLDG/UNIT tail of an address, for "Bldg 1 · Bldg 3" on a card. */
function buildingOf(p) {
  const street = String(p.address || '').split(',')[0].toUpperCase().replace(/\s+/g, ' ').trim();
  const m = street.match(/\s(BLDG|BUILDING)\s*(.+)$/);
  return m ? `Bldg ${m[2].replace(/\s+UNIT\s+/, ' · unit ')}` : null;
}
const usable = (v) => { const n = Number(v); return n > 1 && n < ODD_VALUE ? n : null; };
const dateOf = (p) => (p.filed_date ? new Date(`${String(p.filed_date).slice(0, 10)}T12:00:00Z`).getTime() : null);

/** Union-find over permit ids; returns arrays of rows, one per project. */
function group(rows, { inferences = false } = {}) {
  const parent = new Map(rows.map((r) => [String(r.id), String(r.id)]));
  const basis = new Map();   // root -> Set of link kinds used
  const find = (a) => { let x = a; while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const join = (a, b, why) => {
    const ra = find(a); const rb = find(b);
    const kinds = new Set([...(basis.get(ra) || []), ...(basis.get(rb) || []), why]);
    if (ra !== rb) parent.set(ra, rb);
    basis.set(find(rb), kinds);
  };

  const byJob = new Map();
  const byNumber = new Map();
  for (const r of rows) {
    if (r.permit_number) byNumber.set(`${r.source_area}|${String(r.permit_number).replace(/\s+/g, ' ').toUpperCase()}`, String(r.id));
    const jobKey = r.job && r.job.jobKey;
    if (!jobKey) continue;
    const official = rules.OFFICIAL_JOB_SOURCES.has(r.source_area);
    if (!official && !inferences) continue;
    const k = `${r.source_area}|${jobKey}`;
    if (byJob.has(k)) join(String(r.id), byJob.get(k), official ? 'permit number' : 'same address');
    else byJob.set(k, String(r.id));
  }
  for (const r of rows) {
    const m = rules.REF_RE.exec(r.work_description || '');
    if (!m) continue;
    const base = m[1];
    const target = byJob.get(`${r.source_area}|${base}`) || byNumber.get(`${r.source_area}|${base} BP`);
    if (target) join(String(r.id), target, 'ref in description');
  }
  if (inferences) {
    const byAddr = new Map();
    for (const r of rows) {
      const k = addressKey(r);
      if (!k) continue;
      if (!byAddr.has(k)) byAddr.set(k, []);
      byAddr.get(k).push(r);
    }
    for (const list of byAddr.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => (dateOf(a) || 0) - (dateOf(b) || 0));
      for (let i = 1; i < list.length; i += 1) {
        const gap = (dateOf(list[i]) || 0) - (dateOf(list[i - 1]) || 0);
        if (gap <= rules.ADDRESS_WINDOW_DAYS * DAY) join(String(list[i].id), String(list[i - 1].id), 'same address');
      }
    }
  }

  const groups = new Map();
  for (const r of rows) {
    const root = find(String(r.id));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  }
  return [...groups.entries()].map(([root, members]) => ({ members, basis: [...(basis.get(root) || [])] }));
}

/**
 * The declared value of a project: the sum of its permits' values, counting
 * a value repeated on several permits once (big Austin jobs repeat the whole
 * job's value on every building permit: 2915 E Cesar Chavez, $100M each).
 * $1 placeholders and $1B+ filing errors are left out; the latter are counted.
 */
function projectValue(members) {
  const seen = new Set();
  let total = 0; let counted = 0; let repeated = 0;
  for (const p of members) {
    const v = usable(p.valuation);
    if (v == null) continue;
    if (seen.has(v)) { repeated += 1; continue; }
    seen.add(v); total += v; counted += 1;
  }
  return { total: counted ? total : null, counted, repeated, odd: members.filter((p) => Number(p.valuation) >= ODD_VALUE).length };
}

/** A project as the API returns it: summary for the card, permits for the drawer. */
function summarize({ members, basis }, { inferences = false, matchedIds = null } = {}) {
  const permits = [...members].sort((a, b) => (dateOf(a) || 0) - (dateOf(b) || 0) || Number(a.id) - Number(b.id));
  const kinds = permits.map((p) => rules.kindOf(p));
  const primary = permits.find((p, i) => kinds[i].code === 'BP') || permits[permits.length - 1];
  const [street] = String(primary.address || '').split(',');
  const buildings = [...new Set(permits.map(buildingOf).filter(Boolean))];

  // One chip per kind, coloured by its most advanced active status.
  const order = ['BP', 'DM', 'EP', 'MP', 'PP', 'OT'];
  const rank = { approved: 3, pending: 2, finished: 1, unknown: 0, cancelled: -1 };
  const chips = new Map();
  permits.forEach((p, i) => {
    const k = kinds[i];
    const cur = chips.get(k.code);
    const stage = p.status_stage || 'unknown';
    if (!cur) chips.set(k.code, { code: k.code, label: k.label, count: 1, stage });
    else { cur.count += 1; if ((rank[stage] ?? 0) > (rank[cur.stage] ?? 0)) cur.stage = stage; }
  });

  // Every business phone on the project, newest permit first, once each.
  const phones = [];
  for (const p of [...permits].reverse()) {
    if (!p.contractor_phone || phones.some((x) => x.phone === p.contractor_phone)) continue;
    phones.push({ phone: p.contractor_phone, name: p.contractor_name || null, kind: rules.kindOf(p).code });
  }

  const latest = permits.reduce((m, p) => (p.filed_date && (!m || p.filed_date > m) ? p.filed_date : m), null);
  const first = permits.find((p) => p.filed_date);
  return {
    id: String(primary.id),          // opens the project: /api/projects/by-permit/:id
    primaryId: String(primary.id),
    address: (buildings.length ? street.replace(/\s+(BLDG|BUILDING)\b.*$/i, '') : street).trim(),
    city: primary.city, state: primary.state, zip: primary.zip, sourceArea: primary.source_area,
    jurisdiction: primary.jurisdiction,
    buildings,
    permitCount: permits.length,
    matched: matchedIds ? permits.filter((p) => matchedIds.has(String(p.id))).length : permits.length,
    latest, firstFiled: first ? first.filed_date : null,
    value: projectValue(permits),
    chips: order.filter((c) => chips.has(c)).map((c) => chips.get(c)),
    phones,
    basis: basis.length ? basis : ['single permit'],
    stage: inferences ? rules.stageOf(permits) : null,
    description: primary.work_description || null,
    permitType: primary.permit_type || null,
    permits: permits.map((p, i) => ({
      id: String(p.id), permit_number: p.permit_number, permit_type: p.permit_type, kind: kinds[i].code,
      status_raw: p.status_raw, status_stage: p.status_stage, filed_date: p.filed_date, valuation: p.valuation,
      contractor_name: p.contractor_name, contractor_phone: p.contractor_phone, contractor_withheld: p.contractor_withheld || false,
      address: p.address, work_description: p.work_description,
    })),
  };
}

const SORTERS = {
  newest: (a, b) => String(b.latest || '').localeCompare(String(a.latest || '')) || Number(b.id) - Number(a.id),
  oldest: (a, b) => String(a.latest || '9999').localeCompare(String(b.latest || '9999')) || Number(a.id) - Number(b.id),
  valuation: (a, b) => (b.value.total ?? -1) - (a.value.total ?? -1) || SORTERS.newest(a, b),
};

/**
 * One page of projects for the filtered permits. `rows` from projectRows.
 * `select` (optional) keeps and scores projects (the lens, web/lens.js): it
 * returns null to drop a project or { score, why } to keep it.
 */
function listProjects(rows, { page = 1, pageSize = 25, sort = 'newest', inferences = false, select = null, grouped = true } = {}) {
  const matchedIds = new Set(rows.map((r) => String(r.id)));
  // Ungrouped (the "Group by project" toggle off, with a lens): every permit
  // is its own one-permit project, so the lens can still rank it.
  const groups = grouped ? group(rows, { inferences }) : rows.map((r) => ({ members: [r], basis: [] }));
  let projects = groups.map((g) => summarize(g, { inferences, matchedIds }));
  if (select) {
    projects = projects.map((pr) => { const s = select(pr); return s ? { ...pr, lens: s } : null; }).filter(Boolean);
    projects.sort((a, b) => b.lens.score - a.lens.score || SORTERS[sort in SORTERS ? sort : 'newest'](a, b));
  } else {
    projects.sort(SORTERS[sort in SORTERS ? sort : 'newest']);
  }
  const total = projects.length;
  const start = (page - 1) * pageSize;
  // Cards carry the summary; the timeline is fetched when one is opened.
  const results = projects.slice(start, start + pageSize).map(({ permits, ...card }) => ({ ...card, kinds: permits.map((p) => p.kind) }));
  return { results, total, permitsMatched: rows.length };
}

/** The whole project a permit belongs to, from projectCandidates rows. */
function projectFor(permitId, candidates, { inferences = false } = {}) {
  const id = String(permitId);
  const g = group(candidates, { inferences }).find((x) => x.members.some((r) => String(r.id) === id));
  return g ? summarize(g, { inferences }) : null;
}

/**
 * The project of `permitId`, following links outward: a permit's candidates
 * are one link away (its job number, its address, a Ref either way), so a
 * Ref-linked permit on another street reaches its building permit but not
 * that permit's BLDG 3 neighbour. Each round looks up the members whose
 * address or job number has not been looked up yet, at most `rounds` times.
 * `fetch(id)` is db/queries.js projectCandidates.
 */
async function expandProject(permitId, fetch, { inferences = false, rounds = 3, perRound = 6 } = {}) {
  const id = String(permitId);
  const rows = new Map((await fetch(id)).map((r) => [String(r.id), r]));
  const looked = new Set([id]);
  const covered = new Set();
  const cover = (r) => { covered.add(`a|${addressKey(r)}`); if (r.job && r.job.jobKey) covered.add(`j|${r.source_area}|${r.job.jobKey}`); };
  cover(rows.get(id) || {});
  for (let round = 0; round < rounds; round += 1) {
    const g = group([...rows.values()], { inferences }).find((x) => x.members.some((r) => String(r.id) === id));
    if (!g) return null;
    // Only a member at an address not looked up yet can bring new permits:
    // a building permit's own trade permits share its address.
    const next = [];
    for (const r of g.members) {
      if (next.length >= perRound) break;
      const k = `a|${addressKey(r)}`;
      if (looked.has(String(r.id)) || covered.has(k)) continue;
      covered.add(k);
      next.push(r);
    }
    if (!next.length) break;
    for (const r of next) { looked.add(String(r.id)); cover(r); }
    for (const list of await Promise.all(next.map((r) => fetch(r.id)))) {
      for (const c of list) rows.set(String(c.id), c);
    }
  }
  return projectFor(id, [...rows.values()], { inferences });
}

module.exports = { group, summarize, listProjects, projectFor, expandProject, projectValue, addressKey, buildingOf };
