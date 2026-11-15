// The lens: which projects matter to someone, by what they do. One config,
// tuned here; web/server.js applies it to /api/projects and the welcome popup
// (web/public/lens.js) builds its choices from it (/api/lens).
//
// A lens is an inference (docs/DATA_TRUST_AUDIT.md class C: keyword and
// permit-type rules we wrote), so it filters only when SHOW_INFERENCES=1. Every
// match says why ("no electrical permit filed yet", "“pool” in a description"),
// so a person can judge the reason rather than trust a score.
//
// Signals, each with a weight; a project's score is the sum of what matched:
//   keywords   regexes tried on every permit description in the project
//   kinds      permit kinds present (BP, EP, MP, PP, DM: web/project_stages.js)
//   stages     the project's construction stage label
//   upcoming   a trade kind (EP/PP/MP) that is NOT on the project yet while a
//              building permit is active: work still to be given out. A project
//              that already has that kind is dropped (someone else has it).
//   minValue   the project's declared value is at least this
// A project needs at least `need` points to be shown. Finished and cancelled
// projects never match. Owner-builder filings are not a signal while the
// homeowner gate (ADR-10) keeps them hidden.

const EARLY = ['In permitting', 'Permitted – not started', 'Temp power / site work'];
const NEW_BUILD = /\bnew\s+(construction|single[\s-]?family|sfr|sfd|residence|home|house|duplex|triplex|townhom\w*|multi[\s-]?family|commercial|building|\d+[\s-]?(unit|story))\b|\b\d+[\s-]?unit\b/i;
const k = (re, weight, why) => ({ re, weight, why });

const BASE = {
  supplier: {
    need: 3,
    keywords: [k(NEW_BUILD, 2, 'new construction'), k(/\bdemoli/i, 3, 'demolition'), k(/\b(site\s*work|grading|excavat|clearing)\b/i, 2, 'site work'),
      k(/\baddition\b/i, 1, 'addition')],
    kinds: [{ code: 'DM', weight: 3, why: 'a demolition permit' }],
    stages: [{ labels: EARLY, weight: 2, why: 'early stage' }],
  },
  // A trade needs two real signals (4 points): "interior remodel" alone is too common.
  sub: { need: 4, stages: [{ labels: EARLY.concat('Rough-in (MEP)'), weight: 1, why: 'work still ahead' }] },
  gc: {
    need: 3,
    keywords: [k(NEW_BUILD, 3, 'new construction'), k(/\b(addition|adu|accessory\s+dwelling|garage\s+conversion)\b/i, 3, 'addition / ADU'),
      k(/\b(gut|full|whole[\s-]?house|major)\s+(remodel|renovat)/i, 3, 'large remodel'), k(/\b(tenant\s+finish|finish[\s-]?out|build[\s-]?out|shell)\b/i, 2, 'commercial build-out')],
    stages: [{ labels: ['In permitting', 'Permitted – not started'], weight: 1, why: 'not started yet' }],
    minValue: { value: 100000, weight: 1, why: 'declared value $100K+' },
  },
};

// Sub-options: added to their role's signals.
const OPTIONS = {
  supplier: {
    dumpsters: { label: 'Dumpsters', keywords: [k(/\b(remodel|renovat|re-?roof|gut)\b/i, 1, 'debris-heavy work')] },
    'portable-toilets': { label: 'Portable toilets', keywords: [k(/\bcommercial\b/i, 1, 'commercial job')] },
    fencing: { label: 'Fencing', keywords: [k(/\b(pool|fence|site)\b/i, 1, 'site needs fencing')] },
    materials: { label: 'Building materials', keywords: [k(/\b(addition|framing|remodel)\b/i, 1, 'building work')] },
  },
  sub: {
    electrical: { label: 'Electrical', upcoming: { code: 'EP', weight: 4, why: 'no electrical permit filed yet' }, keywords: [k(/\b(electric|panel|ev\s*charg|service\s+upgrade)/i, 1, 'electrical work described')] },
    plumbing: { label: 'Plumbing', upcoming: { code: 'PP', weight: 4, why: 'no plumbing permit filed yet' }, keywords: [k(/\b(plumb|water\s+heater|bath|kitchen|gas\s+line)/i, 1, 'plumbing work described')] },
    hvac: { label: 'HVAC', upcoming: { code: 'MP', weight: 4, why: 'no mechanical (HVAC) permit filed yet' }, keywords: [k(/\b(hvac|a\/c|air\s+condition|furnace|duct|mechanical)/i, 1, 'HVAC work described')] },
    roofing: { label: 'Roofing', keywords: [k(/\b(re-?roof|roof(ing)?|shingle)\b/i, 4, 'roof work'), k(NEW_BUILD, 2, 'new construction')] },
    drywall: { label: 'Drywall', keywords: [k(NEW_BUILD, 2, 'new construction'), k(/\b(addition|remodel|renovat|finish[\s-]?out|interior)\b/i, 2, 'interior work'), k(/\bdrywall|sheetrock\b/i, 3, 'drywall mentioned')],
      stages: [{ labels: ['Rough-in (MEP)'], weight: 2, why: 'rough-in under way (drywall comes next)' }] },
    insulation: { label: 'Insulation', keywords: [k(NEW_BUILD, 2, 'new construction'), k(/\b(addition|insulat|spray\s+foam)\b/i, 2, 'insulation work')],
      stages: [{ labels: ['Rough-in (MEP)'], weight: 2, why: 'rough-in under way (insulation comes next)' }] },
    flooring: { label: 'Flooring', keywords: [k(NEW_BUILD, 2, 'new construction'), k(/\b(floor|kitchen|remodel|renovat)\w*/i, 2, 'interior remodel')],
      stages: [{ labels: ['Rough-in (MEP)', 'Permitted – not started'], weight: 1, why: 'finishes ahead' }] },
    cabinets: { label: 'Cabinets', keywords: [k(NEW_BUILD, 2, 'new construction'), k(/\b(kitchen|cabinet|bath(room)?)\w*/i, 3, 'kitchen or bath work')],
      stages: [{ labels: ['Rough-in (MEP)', 'Permitted – not started'], weight: 1, why: 'finishes ahead' }] },
    pools: { label: 'Pools', keywords: [k(/\b(pool|spa|hot\s*tub)\b/i, 4, 'pool or spa')] },
    solar: { label: 'Solar', keywords: [k(/\b(solar|photovoltaic|pv\s+(system|panel|array))\b/i, 4, 'solar'), k(NEW_BUILD, 1, 'new construction')] },
    landscaping: { label: 'Landscaping', keywords: [k(NEW_BUILD, 2, 'new construction'), k(/\b(landscap|irrigation|driveway|sidewalk|patio|pool)\w*/i, 2, 'outdoor work')] },
  },
};

const ROLES = [
  { key: 'sub', label: 'Subcontractor / trade', sub: 'Your trade, on jobs where it is still to come', options: 'sub' },
  { key: 'gc', label: 'General contractor / builder', sub: 'New builds, additions, ADUs, large remodels' },
  { key: 'supplier', label: 'Supplier or equipment rental', sub: 'Dumpsters, portable toilets, fencing, materials', options: 'supplier' },
];

/** "sub.drywall,gc" -> [{ role, option, label, spec }], unknown parts dropped. */
function parseLens(param) {
  const out = [];
  for (const part of String(param || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [role, option] = part.split('.');
    if (!BASE[role]) continue;
    if (option && !(OPTIONS[role] && OPTIONS[role][option])) continue;
    const opt = option ? OPTIONS[role][option] : null;
    const roleLabel = ROLES.find((r) => r.key === role).label.split(' / ')[0];
    out.push({ role, option: option || null, label: opt ? opt.label : roleLabel, spec: merge(BASE[role], opt) });
  }
  return out;
}
function merge(base, opt) {
  if (!opt) return base;
  return {
    need: base.need,
    keywords: [...(base.keywords || []), ...(opt.keywords || [])],
    kinds: [...(base.kinds || []), ...(opt.kinds || [])],
    stages: [...(base.stages || []), ...(opt.stages || [])],
    upcoming: opt.upcoming || base.upcoming || null,
    minValue: opt.minValue || base.minValue || null,
  };
}

/** Score one project (a /api/projects summary with `permits` and `kinds`) against one lens part. */
function scoreOne(pr, spec) {
  if (pr.stage === 'Finished' || pr.stage === 'Cancelled') return null;
  const texts = (pr.permits || []).map((p) => p.work_description || '').concat(pr.description || '');
  const kinds = new Set(pr.kinds || (pr.permits || []).map((p) => p.kind));
  const why = [];
  let score = 0;
  if (spec.upcoming) {
    if (kinds.has(spec.upcoming.code)) return null;   // already permitted by someone
    const activeBp = (pr.permits || []).some((p) => p.kind === 'BP' && (p.status_stage === 'approved' || p.status_stage === 'pending'))
      || (!pr.permits && kinds.has('BP'));
    if (activeBp) { score += spec.upcoming.weight; why.push(spec.upcoming.why); }
  }
  for (const kw of spec.keywords || []) {
    if (texts.some((t) => kw.re.test(t))) { score += kw.weight; why.push(kw.why); }
  }
  for (const kd of spec.kinds || []) if (kinds.has(kd.code)) { score += kd.weight; why.push(kd.why); }
  for (const st of spec.stages || []) if (pr.stage && st.labels.includes(pr.stage)) { score += st.weight; why.push(st.why); }
  if (spec.minValue && pr.value && pr.value.total >= spec.minValue.value) { score += spec.minValue.weight; why.push(spec.minValue.why); }
  return score >= (spec.need || 1) ? { score, why: [...new Set(why)] } : null;
}

/** A select function for web/projects.js listProjects, the best part winning. */
function selector(param) {
  const parts = parseLens(param);
  if (!parts.length) return null;
  const select = (pr) => {
    let best = null;
    for (const part of parts) {
      const s = scoreOne(pr, part.spec);
      if (s && (!best || s.score > best.score)) best = { ...s, label: part.label };
    }
    return best;
  };
  select.label = parts.map((p) => p.label).join(', ');
  select.param = parts.map((p) => (p.option ? `${p.role}.${p.option}` : p.role)).join(',');
  return select;
}

/** What the popup offers (no regexes: those stay on the server). */
function publicConfig() {
  return {
    roles: ROLES.map((r) => ({ key: r.key, label: r.label, sub: r.sub,
      options: r.options ? Object.entries(OPTIONS[r.options]).map(([key, o]) => ({ key, label: o.label })) : [] })),
  };
}

module.exports = { parseLens, scoreOne, selector, publicConfig, ROLES, OPTIONS, BASE };
