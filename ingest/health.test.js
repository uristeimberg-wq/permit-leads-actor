const assert = require('node:assert');
const { evaluate } = require('./health.js');

const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
};
const now = new Date('2026-11-13T18:00:00Z');
const healthy = () => ({
  now,
  sources: [{ slug: 'austin-tx', stale: false, consecutive_failures: 0 }, { slug: 'miami-dade-fl', stale: false, consecutive_failures: 0 }],
  dataAge: [{ source_area: 'austin-tx', newest: '2026-11-11', days_old: 2 }, { source_area: 'miami-dade-fl', newest: '2026-11-05', days_old: 8 }],
  events: [],
  resolver: { status: 'succeeded', last_success_at: '2026-11-13T17:20:00Z' },
  sizeBytes: 300 * 1048576,
});

check('a healthy system has no problems', () => assert.deepStrictEqual(evaluate(healthy()).problems, []));

check('a stale source is a problem, with its failure count', () => {
  const m = healthy();
  m.sources[0] = { slug: 'austin-tx', stale: true, last_success_at: '2026-11-11T17:20:00Z', consecutive_failures: 2, last_error_class: 'transient' };
  const [p] = evaluate(m).problems;
  assert.match(p, /austin-tx: no successful sync since 2026-11-11.*2 failed run\(s\).*transient/);
});

check('data older than the source allows is a problem even when syncs succeed', () => {
  const m = healthy();
  m.dataAge[0].days_old = 6;
  assert.match(evaluate(m).problems[0], /austin-tx: newest permit issued 6 days ago/);
});

check('Miami-Dade tolerates its weekly publication lag', () => {
  const m = healthy();
  m.dataAge[1].days_old = 15;
  assert.deepStrictEqual(evaluate(m).problems, []);
});

check('a source with no permits at all is a problem', () => {
  const m = healthy();
  m.dataAge = m.dataAge.slice(1);
  assert.match(evaluate(m).problems[0], /austin-tx: newest permit issued never/);
});

check('only error-level schema events alarm', () => {
  const m = healthy();
  m.events = [
    { slug: 'austin-tx', kind: 'schema_change', severity: 'warning', detail: { missingMappedField: 'a_val' }, created_at: now },
    { slug: 'austin-tx', kind: 'schema_change', severity: 'error', detail: { missingMappedField: 'contractor_phone' }, created_at: now },
  ];
  const { problems } = evaluate(m);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /contractor_phone/);
});

check('a failed or overdue resolver is a problem', () => {
  const failed = healthy(); failed.resolver.status = 'failed';
  assert.strictEqual(evaluate(failed).problems.length, 1);
  const overdue = healthy(); overdue.resolver.last_success_at = '2026-11-12T01:00:00Z';
  assert.strictEqual(evaluate(overdue).problems.length, 1);
});

check('storage above the alert threshold is a problem', () => {
  const m = healthy(); m.sizeBytes = 4500 * 1048576;
  assert.match(evaluate(m).problems[0], /storage: 4500 MB of 5120 MB/);
  m.sizeBytes = 900 * 1048576; // the old Free-plan alarm level is fine on Launch
  assert.deepStrictEqual(evaluate(m).problems, []);
});

check('a failed re-read, or a permit unconfirmed for too long, is a problem', () => {
  const m = healthy();
  m.reread = [
    { slug: 'austin-tx', oldest_days: 3, missing: 0, last_refresh_status: 'succeeded' },
    { slug: 'miami-city-fl', oldest_days: 31, missing: 2, last_refresh_status: 'failed', last_refresh_error: 'bad_data' },
  ];
  const ps = evaluate(m).problems;
  assert.strictEqual(ps.length, 2);
  assert.match(ps[0], /miami-city-fl: the last re-read failed \(bad_data\)/);
  assert.match(ps[1], /miami-city-fl: .*31 days ago, limit 30/);
});

check('before migration 030 the re-read is not measured and raises nothing', () => {
  const m = healthy();
  m.reread = null;
  assert.deepStrictEqual(evaluate(m).problems, []);
});
