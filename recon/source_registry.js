// Source registry scorer (docs/DATA_STRATEGY.md section 5).
//
// Reads the human-reviewed registry (docs/research/source_registry.json),
// validates it, scores each source on the uniqueness-weighted rubric and
// prints the recommended next action. It reads no network and writes nothing.
//
//   node recon/source_registry.js [--file=path] [--json]
//
// The score ranks candidates; it never enables a source. Legal feasibility is
// a gate, not a weight: a blocked source is excluded whatever it scores, and a
// source that needs counsel is listed but not recommended for engineering.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const WEIGHTS = {
  early: 20, unique: 15, action: 15, contact: 10,
  fresh: 10, coverage: 10, reliability: 10, cost: 10,
};
const CRITERIA = [...Object.keys(WEIGHTS), 'legal'];
const STAGES = ['land', 'entitlement', 'site_plan', 'building_application', 'issued_permit',
  'construction_activity', 'completion', 'none'];
const GATES = ['open', 'counsel', 'blocked'];
const STATUSES = ['live', 'candidate', 'probe', 'deferred', 'on_hold', 'excluded'];
const BASES = ['measured', 'estimated'];
const REQUIRED = ['id', 'name', 'jurisdiction', 'category', 'url', 'earliest_stage', 'access',
  'terms', 'legal_gate', 'cadence', 'status', 'verified', 'verified_on', 'basis', 'scores'];

function validate(reg) {
  const errors = [];
  if (!reg || !Array.isArray(reg.sources)) return ['registry has no sources array'];
  const seen = new Set();
  for (const s of reg.sources) {
    const where = s && s.id ? s.id : '(no id)';
    for (const f of REQUIRED) if (s[f] === undefined || s[f] === null || s[f] === '') errors.push(`${where}: missing ${f}`);
    if (seen.has(s.id)) errors.push(`${where}: duplicate id`);
    seen.add(s.id);
    if (s.earliest_stage && !STAGES.includes(s.earliest_stage)) errors.push(`${where}: unknown stage ${s.earliest_stage}`);
    if (s.legal_gate && !GATES.includes(s.legal_gate)) errors.push(`${where}: unknown legal_gate ${s.legal_gate}`);
    if (s.status && !STATUSES.includes(s.status)) errors.push(`${where}: unknown status ${s.status}`);
    if (s.basis && !BASES.includes(s.basis)) errors.push(`${where}: unknown basis ${s.basis}`);
    if (s.verified_on && !/^\d{4}-\d{2}-\d{2}$/.test(s.verified_on)) errors.push(`${where}: verified_on is not a date`);
    for (const c of CRITERIA) {
      const v = s.scores && s.scores[c];
      if (!Number.isInteger(v) || v < 1 || v > 5) errors.push(`${where}: score ${c} must be an integer 1-5`);
    }
  }
  return errors;
}

// 0-100: each criterion's 1-5 score mapped to 0-1, times its weight.
function score(s) {
  let total = 0;
  for (const [c, w] of Object.entries(WEIGHTS)) total += w * (s.scores[c] - 1) / 4;
  return Math.round(total);
}

// The next action for a source. Order matters: gates first, then status, then evidence.
function action(s, points = score(s)) {
  if (s.status === 'live') return 'live';
  if (s.legal_gate === 'blocked' || s.status === 'excluded') return 'skip';
  if (s.legal_gate === 'counsel') return 'counsel';
  if (s.status === 'on_hold' || s.status === 'deferred') return 'deferred';
  // Registries of firms are join keys, judged by link value, not lead value.
  if (s.category === 'entity_reference') return 'reference';
  if (points < 45) return 'skip';
  if (s.basis === 'estimated' || s.status === 'probe') return 'verify';
  return points >= 55 ? 'pilot' : 'backlog';
}

const ACTION_ORDER = ['pilot', 'verify', 'backlog', 'reference', 'counsel', 'deferred', 'skip', 'live'];

function rank(reg) {
  return reg.sources
    .map((s) => { const points = score(s); return { ...s, points, action: action(s, points) }; })
    .sort((a, b) => ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action)
      || b.points - a.points || a.id.localeCompare(b.id));
}

function toMarkdown(rows) {
  const out = ['| Action | Score | Source | Earliest stage | Gate | Basis |', '| --- | --- | --- | --- | --- | --- |'];
  for (const r of rows) out.push(`| ${r.action} | ${r.points} | ${r.name} (\`${r.id}\`) | ${r.earliest_stage} | ${r.legal_gate} | ${r.basis} |`);
  return out.join('\n');
}

if (require.main === module) {
  const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
  const file = arg('file') || path.join(__dirname, '..', 'docs', 'research', 'source_registry.json');
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errors = validate(reg);
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  const rows = rank(reg);
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows.map(({ id, points, action: a }) => ({ id, points, action: a })), null, 2));
  else console.log(toMarkdown(rows));
}

module.exports = { WEIGHTS, validate, score, action, rank, toMarkdown };
