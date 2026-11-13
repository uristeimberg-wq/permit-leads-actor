// Numbered SQL migrations: db/migrations/NNN_name.sql, applied in order, each
// in its own transaction, recorded in schema_migrations with a checksum.
//
// A migration that was already applied and whose file has since changed is an
// error, not a re-run: editing history is how two databases drift apart
// silently. Add a new file instead.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

/**
 * Pure: turn a directory listing into ordered migrations. Throws on anything
 * that would make the order ambiguous.
 * @param {string[]} filenames
 * @param {(name: string) => string} readFile
 */
function planMigrations(filenames, readFile) {
  const seen = new Map();
  const migrations = [];
  for (const name of filenames) {
    if (!name.endsWith('.sql')) continue;
    const m = FILE_PATTERN.exec(name);
    if (!m) throw new Error(`Migration file "${name}" must be named NNN_snake_case.sql`);
    const version = Number(m[1]);
    if (seen.has(version)) throw new Error(`Two migrations share version ${m[1]}: ${seen.get(version)} and ${name}`);
    seen.set(version, name);
    const sql = readFile(name);
    migrations.push({ version, name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') });
  }
  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((mig, i) => {
    if (mig.version !== i + 1) throw new Error(`Migrations must be numbered 001, 002, ... without gaps; found ${mig.name} at position ${i + 1}`);
  });
  return migrations;
}

/**
 * Pure: given what is on disk and what the database has recorded, decide what
 * to run. Throws if an applied migration's file has changed or disappeared.
 * @param {{version:number,name:string,checksum:string}[]} planned
 * @param {{version:number,checksum:string}[]} applied
 */
function pendingMigrations(planned, applied) {
  const byVersion = new Map(planned.map((m) => [m.version, m]));
  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (!file) throw new Error(`Database has migration ${row.version} applied, but no file for it exists`);
    if (file.checksum !== row.checksum) {
      throw new Error(`Migration ${file.name} was edited after being applied (checksum mismatch). Add a new migration instead.`);
    }
  }
  const done = new Set(applied.map((r) => r.version));
  return planned.filter((m) => !done.has(m.version));
}

function loadMigrations(dir = MIGRATIONS_DIR) {
  return planMigrations(fs.readdirSync(dir), (name) => fs.readFileSync(path.join(dir, name), 'utf8'));
}

/**
 * Apply pending migrations. Holds an advisory lock so two processes starting
 * at once (worker + web) cannot both run them.
 * @param {import('pg').Pool} pool
 * @param {{log?: (msg: string) => void}} [options]
 */
async function migrate(pool, { log = () => {} } = {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
    const todo = pendingMigrations(loadMigrations(), rows);
    for (const mig of todo) {
      await client.query('BEGIN');
      try {
        await client.query(mig.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [mig.version, mig.name, mig.checksum],
        );
        await client.query('COMMIT');
        log(`applied migration ${mig.name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${mig.name} failed: ${err.message}`);
      }
    }
    return todo.map((m) => m.name);
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}

module.exports = { migrate, planMigrations, pendingMigrations, loadMigrations, MIGRATIONS_DIR };
