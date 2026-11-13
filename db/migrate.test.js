const assert = require('node:assert');
const { planMigrations, pendingMigrations, loadMigrations } = require('./migrate.js');

function check(name, fn) {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const files = { '001_baseline.sql': 'SELECT 1;', '002_sources.sql': 'SELECT 2;' };
const read = (name) => files[name];

check('migrations are ordered by version, whatever the listing order', () => {
  const plan = planMigrations(['002_sources.sql', '001_baseline.sql', 'README.md'], read);
  assert.deepStrictEqual(plan.map((m) => m.name), ['001_baseline.sql', '002_sources.sql']);
});

check('a badly named file is refused rather than skipped', () => {
  assert.throws(() => planMigrations(['1_baseline.sql'], () => ''), /NNN_snake_case/);
  assert.throws(() => planMigrations(['001-baseline.sql'], () => ''), /NNN_snake_case/);
});

check('two files with the same number are refused', () => {
  assert.throws(() => planMigrations(['001_a.sql', '001_b.sql'], () => ''), /share version 001/);
});

check('a gap in numbering is refused', () => {
  assert.throws(() => planMigrations(['001_a.sql', '003_c.sql'], () => ''), /without gaps/);
});

check('only unapplied migrations are pending', () => {
  const plan = planMigrations(Object.keys(files), read);
  const pending = pendingMigrations(plan, [{ version: 1, checksum: plan[0].checksum }]);
  assert.deepStrictEqual(pending.map((m) => m.name), ['002_sources.sql']);
});

check('editing an applied migration is an error, not a silent re-run', () => {
  const plan = planMigrations(Object.keys(files), read);
  assert.throws(() => pendingMigrations(plan, [{ version: 1, checksum: 'different' }]), /edited after being applied/);
});

check('an applied migration whose file is gone is an error', () => {
  const plan = planMigrations(['001_baseline.sql'], read);
  assert.throws(() => pendingMigrations(plan, [{ version: 1, checksum: plan[0].checksum }, { version: 2, checksum: 'x' }]), /no file/);
});

check('the real migrations directory plans cleanly and starts with the baseline', () => {
  const plan = loadMigrations();
  assert.strictEqual(plan[0].name, '001_baseline.sql');
  assert.match(plan[0].sql, /CREATE TABLE IF NOT EXISTS permits/);
  assert.match(plan[0].sql, /CREATE TABLE IF NOT EXISTS ingest_runs/);
});

console.log('\nDone.');
