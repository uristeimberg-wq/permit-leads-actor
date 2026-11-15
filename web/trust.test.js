// Offline checks for web/trust.js: inferences leave the API unless
// SHOW_INFERENCES=1 (docs/DATA_TRUST_AUDIT.md).
const assert = require('node:assert');
const T = require('./trust.js');

// Inference rules alone; the unmeasured rules (ADR-32, ADR-33) are tested below.
const OFF = { SHOW_UNMEASURED: '1' };
const ON = { SHOW_INFERENCES: '1', SHOW_UNMEASURED: '1' };

// Flag on: answers are untouched.
const anyBody = { tradeOutlook: { electrical: { likelihood: 0.5 } }, permit: { source_area: 'austin-tx', trade_scores: { electrical: 90 } } };
assert.strictEqual(T.filter('job', anyBody, ON), anyBody);
assert.strictEqual(T.showInferences(ON), true);
assert.strictEqual(T.showInferences(OFF), false);

// Error answers pass through.
const notFound = { status: 404, json: { error: 'x' } };
assert.strictEqual(T.filter('job', notFound, OFF), notFound);

// Job: estimates, fit score, registrations and name or phone licence matches go.
const job = T.filter('job', {
  permit: { source_area: 'austin-tx', permit_number: '1', trade_scores: { electrical: 90 } },
  tradeOutlook: { electrical: { likelihood: 0.5 } },
  gcRegistry: [{ matchedBy: 'licence', number: 'A' }, { matchedBy: 'name_state', number: 'B' }, { matchedBy: 'phone', number: 'C' }],
  gcRegistrations: [{ legalName: 'X LLC' }],
  related: [{ trade: 'electrical' }],
  gcHiring: { subs: [] },
}, { SHOW_UNMEASURED: '1' });
assert.deepStrictEqual(job.tradeOutlook, {});
assert.ok(!('trade_scores' in job.permit));
assert.deepStrictEqual(job.gcRegistry.map((r) => r.number), ['A']);
assert.deepStrictEqual(job.gcRegistrations, []);
assert.strictEqual(job.related.length, 1, 'official job keys keep their trade permits');
assert.ok(job.gcHiring, 'and the GC history');
assert.strictEqual(job.inferencesHidden, true);

// Raleigh links jobs by parcel: no trade-on-job, no GC history.
const ral = T.filter('job', { permit: { source_area: 'raleigh-nc' }, related: [{ trade: 'plumbing' }], gcHiring: { subs: [] }, tradePermitIssued: true }, OFF);
assert.deepStrictEqual(ral.related, []);
assert.strictEqual(ral.gcHiring, null);
assert.strictEqual(ral.tradePermitIssued, null);
assert.strictEqual(ral.jobLinksHidden, T.PIN_NOTE);

// Contractor: licence-number matches only; NC relationships withheld.
const c = T.filter('contractor', { contractor: { name: 'A', businessState: 'NC' }, registry: [{ matchedBy: 'name_state' }], registrations: [{}], subsHired: [{}], gcsWorkedFor: [{}] }, OFF);
assert.deepStrictEqual(c.registry, []);
assert.deepStrictEqual(c.registrations, []);
assert.deepStrictEqual(c.subsHired, []);
assert.ok(c.relationshipsHidden);
const tx = T.filter('contractor', { contractor: { name: 'A', businessState: 'TX' }, registry: [], registrations: [], subsHired: [{}], gcsWorkedFor: [] }, OFF);
assert.strictEqual(tx.subsHired.length, 1);

// Weekly list: no score, newest first.
const l = T.filter('leads', { leads: [{ id: 1, score: 90, issuedOn: '2026-11-01' }, { id: 2, score: 10, issuedOn: '2026-11-10' }] }, OFF);
assert.deepStrictEqual(l.leads.map((x) => x.id), [2, 1]);
assert.ok(l.leads.every((x) => !('score' in x)));
assert.strictEqual(l.ranking, 'issue date');

// Early: no forecast, no role, no builder subs.
const e = T.filter('early', { filings: [{ issueForecast: { lowOn: 'x' }, builderSubs: [{}], filer: { name: 'B', role: 'expediter', basis: 'name says so' } }] }, OFF);
assert.strictEqual(e.filings[0].issueForecast, null);
assert.deepStrictEqual(e.filings[0].builderSubs, []);
assert.strictEqual(e.filings[0].filer.role, 'unknown');
assert.strictEqual(e.filings[0].filer.name, 'B');

// Momentum: counts stay, labels and filer-based applications go.
const m = T.filter('momentum', { filters: { source: 'austin-tx' }, counts: { rising: 1 }, hasApplications: true,
  builders: [{ builder: { id: 1 }, recent: 3, prior: 1, trend: 'rising', applications: { filed: 2 }, topSubs: [{}] },
    { builder: { id: 2 }, recent: 9, prior: 9, trend: 'steady', applications: null, topSubs: [] }] }, OFF);
assert.deepStrictEqual(m.builders.map((b) => b.builder.id), [2, 1], 'sorted by recent count');
assert.ok(m.builders.every((b) => !('trend' in b) && !('applications' in b)));
assert.strictEqual(m.builders[1].recent, 3);
assert.strictEqual(m.builders[1].topSubs.length, 1);
assert.strictEqual(m.counts, null);
assert.strictEqual(m.hasApplications, false);

// GCs and overview: Raleigh only.
assert.ok(T.filter('gcs', { filters: { source: 'raleigh-nc' }, gcs: [{}], baseline: { repeatRate: 0.9, topSubs: [{}] } }, OFF).jobLinksHidden);
assert.strictEqual(T.filter('gcs', { filters: { source: 'austin-tx' }, gcs: [{}], baseline: {} }, OFF).gcs.length, 1);
const o = T.filter('overview', { source: 'raleigh-nc', repeatHiring: { electrical: {} }, topGcs: [{ subsHired: 3 }], recent: [{ trades: ['electrical'] }] }, OFF);
assert.strictEqual(o.topGcs[0].subsHired, null);
assert.strictEqual(o.recent[0].trades, null);
assert.deepStrictEqual(o.repeatHiring, {});

// Street View is off.
assert.deepStrictEqual(T.filter('imagery', { googleKey: 'k' }, OFF), {});

// Unmeasured second-source values (owner, 2026-11-15) are hidden by default,
// independently of the inference flag.
const um = T.filter('job', { permit: { source_area: 'austin-tx' }, property: { landUse: 'x' }, gcRegistry: [{ matchedBy: 'licence', number: '1' }] }, { SHOW_INFERENCES: '1' });
assert.strictEqual(um.property, null);
assert.deepStrictEqual(um.gcRegistry, []);
assert.strictEqual(um.unmeasuredHidden, T.UNMEASURED_NOTE);
const shown = T.filter('job', { permit: { source_area: 'austin-tx' }, property: { landUse: 'x' }, gcRegistry: [{ matchedBy: 'licence', number: '1' }] }, { SHOW_UNMEASURED: '1' });
assert.deepStrictEqual(shown.property, { landUse: 'x' });
assert.strictEqual(shown.gcRegistry.length, 1);
assert.deepStrictEqual(T.filter('contractor', { contractor: { name: 'A', businessState: 'TX' }, registry: [{ matchedBy: 'licence' }] }, {}).registry, []);

// Job links (ADR-33) are hidden in every market by default.
const jl = T.filter('job', { permit: { source_area: 'austin-tx' }, related: [{ trade: 'electrical' }], gcHiring: { subs: [{}] }, tradePermitIssued: true }, {});
assert.deepStrictEqual([jl.related, jl.gcHiring, jl.tradePermitIssued, jl.jobLinksHidden], [[], null, null, T.JOB_LINKS_NOTE]);
const jr = T.filter('job', { permit: { source_area: 'raleigh-nc' }, related: [{}] }, {});
assert.strictEqual(jr.jobLinksHidden, T.PIN_NOTE, 'Raleigh keeps its more specific note');
const cj = T.filter('contractor', { contractor: { name: 'A', businessState: 'FL' }, registry: [], subsHired: [{}], gcsWorkedFor: [{}] }, {});
assert.deepStrictEqual([cj.subsHired, cj.gcsWorkedFor, cj.relationshipsHidden], [[], [], T.JOB_LINKS_NOTE]);
const g = T.filter('gcs', { filters: { source: 'miami-dade-fl' }, gcs: [{}], baseline: { repeatRate: 0.5, topSubs: [{}] } }, {});
assert.deepStrictEqual([g.gcs, g.baseline.repeatRate, g.baseline.topSubs], [[], null, []]);
const ov = T.filter('overview', { source: 'austin-tx', repeatHiring: { electrical: {} }, topGcs: [{ subsHired: 3, linkedJobs: 2 }], recent: [{ trades: ['x'] }] }, {});
assert.deepStrictEqual([ov.repeatHiring, ov.topGcs[0].subsHired, ov.topGcs[0].linkedJobs, ov.recent[0].trades], [{}, null, null, null]);
assert.deepStrictEqual(T.filter('momentum', { filters: { source: 'austin-tx' }, builders: [{ recent: 1, topSubs: [{}] }] }, {}).builders[0].topSubs, []);
assert.deepStrictEqual(T.filter('leads', { leads: [{ id: 1 }] }, {}).leads, []);
// Shown again only with SHOW_UNMEASURED=1.
assert.strictEqual(T.filter('job', { permit: { source_area: 'austin-tx' }, related: [{}] }, { SHOW_UNMEASURED: '1' }).related.length, 1);
const { locationSql } = require('../src/display_policy.js');
assert.strictEqual(locationSql('l', {}), "l.method IN ('source', 'parcel')");
assert.strictEqual(locationSql('l', { SHOW_UNMEASURED: '1' }), 'TRUE');

console.log('trust.test.js: all passed');
