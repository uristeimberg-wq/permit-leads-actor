// The lens (web/lens_config.js): parsing, matching, the "already permitted"
// rule and the reasons given. Offline, on hand-made project summaries.
const assert = require('node:assert');
const { parseLens, scoreOne, selector, publicConfig } = require('./lens_config.js');

const permit = (o) => ({ kind: 'BP', status_stage: 'approved', work_description: '', ...o });
const project = (permits, o = {}) => ({ permits, kinds: permits.map((p) => p.kind), stage: 'Permitted – not started', value: { total: null }, ...o });
const spec = (param) => parseLens(param)[0].spec;

// Parsing: unknown roles and options are dropped; labels come from the config.
assert.deepStrictEqual(parseLens('sub.drywall,gc,nope,sub.nope').map((p) => p.label), ['Drywall', 'General contractor']);
assert.strictEqual(selector(''), null);
assert.strictEqual(selector('sub.drywall,sub.flooring').label, 'Drywall, Flooring');

// Electrical: a building permit with no electrical permit yet is the lead...
const bpOnly = project([permit()]);
assert.deepStrictEqual(scoreOne(bpOnly, spec('sub.electrical')).why[0], 'no electrical permit filed yet');
// ...and a project that already has one is someone else's.
assert.strictEqual(scoreOne(project([permit(), permit({ kind: 'EP' })]), spec('sub.electrical')), null);

// Keywords say what matched.
const pool = project([permit({ work_description: 'New pool and spa in rear yard' })]);
assert.ok(scoreOne(pool, spec('sub.pools')).why.includes('pool or spa'));
assert.strictEqual(scoreOne(project([permit({ work_description: 'Replace water heater' })]), spec('sub.pools')), null);

// A trade needs two real signals: "remodel" alone is not a drywall lead.
assert.strictEqual(scoreOne(project([permit({ work_description: 'Interior remodel' })], { stage: null }), spec('sub.drywall')), null);
assert.ok(scoreOne(project([permit({ work_description: 'Interior remodel, new drywall' })], { stage: 'Rough-in (MEP)' }), spec('sub.drywall')));

// Finished and cancelled projects never match.
assert.strictEqual(scoreOne(project([permit({ work_description: 'New pool' })], { stage: 'Finished' }), spec('sub.pools')), null);

// GC: new construction; supplier: demolition and early stage.
assert.ok(scoreOne(project([permit({ work_description: 'New construction single family residence' })]), spec('gc')));
assert.ok(scoreOne(project([permit({ kind: 'DM', work_description: 'Demolition of house' })], { stage: 'Temp power / site work' }), spec('supplier.dumpsters')));

// The selector keeps the best part and its label.
const both = selector('sub.pools,sub.electrical')(project([permit({ work_description: 'New pool' })]));
assert.ok(['Pools', 'Electrical'].includes(both.label));

// The popup gets labels and options, never the regexes.
const cfg = publicConfig();
assert.deepStrictEqual(cfg.roles.map((r) => r.key), ['sub', 'gc', 'supplier']);
assert.ok(cfg.roles[0].options.some((o) => o.key === 'drywall'));
assert.ok(!JSON.stringify(cfg).includes('\\b'));

console.log('lens_config.test.js: all passed');
