const assert = require('node:assert');
const { resolveScheduleConfig, maxFor } = require('./config.js');
const { SOURCES, PILOT_AREAS } = require('../src/sources.js');

function check(name, fn) {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

check('with no env, the scheduler refreshes the pilot markets, not Oregon', () => {
  const cfg = resolveScheduleConfig({});
  assert.deepStrictEqual(cfg.runs.map((r) => r.area), ['austin-tx', 'miami-dade-fl']);
  assert.ok(!cfg.runs.some((r) => r.area.includes('oregon') || r.area.includes('clackamas')));
});

check('pilot areas all exist as sources', () => {
  for (const area of PILOT_AREAS) assert.ok(SOURCES[area], `${area} missing from SOURCES`);
});

check('every source declares a positive maxPerRun', () => {
  for (const [area, source] of Object.entries(SOURCES)) {
    assert.ok(Number.isInteger(source.maxPerRun) && source.maxPerRun > 0, `${area} has no maxPerRun`);
  }
});

check('default caps come from each source, so Austin is not truncated at 300', () => {
  const cfg = resolveScheduleConfig({});
  const austin = cfg.runs.find((r) => r.area === 'austin-tx');
  // ~158/day x 7 days default window ~= 1,100: the cap must clear that.
  assert.ok(austin.max >= 7 * 158, `Austin cap ${austin.max} is below a week of permits`);
});

check('INGEST_MAX can lower a cap but never raise it past the source ceiling', () => {
  assert.strictEqual(maxFor('miami-dade-fl', 100), 100);
  assert.strictEqual(maxFor('miami-dade-fl', 99999), SOURCES['miami-dade-fl'].maxPerRun);
  assert.strictEqual(maxFor('miami-dade-fl', undefined), SOURCES['miami-dade-fl'].maxPerRun);
});

check('INGEST_AREAS still selects areas explicitly, including Oregon', () => {
  const cfg = resolveScheduleConfig({ INGEST_AREAS: 'clackamas-county-or, austin-tx' });
  assert.deepStrictEqual(cfg.runs.map((r) => r.area), ['clackamas-county-or', 'austin-tx']);
});

check('an unknown area fails loudly instead of being skipped', () => {
  assert.throws(() => resolveScheduleConfig({ INGEST_AREAS: 'austin-tx,austn-tx' }), /Unknown area/);
});

check('bad numbers fail loudly', () => {
  assert.throws(() => resolveScheduleConfig({ INGEST_DAYS: 'seven' }), /INGEST_DAYS/);
  assert.throws(() => resolveScheduleConfig({ INGEST_MAX: '0' }), /INGEST_MAX/);
});

check('Austin uses its own two sync windows unless INGEST_DAYS is set (ADR-11)', () => {
  assert.deepStrictEqual(SOURCES['austin-tx'].syncWindows.map((w) => w.field), ['issue_date', 'statusdate']);
  assert.strictEqual(resolveScheduleConfig({}).daysExplicit, false);
  assert.strictEqual(resolveScheduleConfig({ INGEST_DAYS: '3' }).daysExplicit, true);
});

check('interval and window defaults are unchanged (6h, 7 days)', () => {
  const cfg = resolveScheduleConfig({});
  assert.strictEqual(cfg.intervalMinutes, 360);
  assert.strictEqual(cfg.days, 7);
});

console.log('\nDone.');
