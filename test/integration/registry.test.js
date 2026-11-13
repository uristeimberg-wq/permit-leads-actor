// Integration: every source with a `registry` block in src/sources.js has a
// matching row in the migrated sources table, so a new connector cannot ship
// as config only (ingest would throw "not in the sources table"), and the
// config and database cannot quietly disagree. Needs Postgres.

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_r_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { SOURCES, PILOT_AREAS } = require('../../src/sources.js');
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
  };
  try {
    await db.applySchema();
    const { rows } = await db.query(`SELECT s.slug, s.kind, s.sync_mode, s.enabled, s.expected_interval::text AS expected_interval,
                                            s.automated_access, s.redistribution, j.slug AS jurisdiction
                                       FROM sources s JOIN jurisdictions j ON j.id = s.jurisdiction_id`);
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]));
    for (const [slug, src] of Object.entries(SOURCES).filter(([, s]) => s.registry)) {
      await check(`${slug}: sources row matches the registry config`, async () => {
        const r = bySlug[slug];
        assert.ok(r, `no sources row; add one in a new db/migrations file`);
        const reg = src.registry;
        assert.deepStrictEqual(
          { kind: r.kind, sync_mode: r.sync_mode, jurisdiction: r.jurisdiction, enabled: r.enabled },
          { kind: src.type, sync_mode: reg.syncMode, jurisdiction: reg.jurisdiction, enabled: PILOT_AREAS.includes(slug) },
        );
        const { rows: [{ same }] } = await db.query('SELECT $1::interval = $2::interval AS same', [r.expected_interval, reg.expectedInterval]);
        assert.ok(same, `expected_interval ${r.expected_interval} vs config ${reg.expectedInterval}`);
        assert.deepStrictEqual([r.automated_access, r.redistribution], [reg.terms.automatedAccess, reg.terms.redistribution]);
      });
    }
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.end();
  }
  if (failures) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
