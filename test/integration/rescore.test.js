// Integration: ingest/rescore.js rewrites stored trade scores with the current
// rules, only where they change, and leaves version history alone.
// Needs Postgres (DATABASE_URL; default :5433).

const assert = require('node:assert');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://permits:permits@localhost:5433/permits';
const DB_NAME = `permits_it_rs_${process.pid}`;
const testUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000';
const row = (num, type, description) => ({
  permit_number: `2026-${num} ${type}`, permittype: type, permit_type_desc: `${type} Permit`, description,
  status_current: 'Active', issue_date: daysAgo(3), original_address1: `${num} MAIN ST`,
  original_city: 'AUSTIN', original_state: 'TX', original_zip: '78704',
  contractor_company_name: 'Acme Builders LLC', contractor_phone: '5125550100', total_job_valuation: '1000',
});

const realFetch = global.fetch;
let pages = [];
global.fetch = async () => { const page = pages.shift() || []; return { ok: true, json: async () => page, text: async () => '' }; };

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = testUrl;
  const db = require('../../db/index.js');
  const { ingestArea } = require('../../ingest/run.js');
  const { rescoreAll } = require('../../ingest/rescore.js');
  try {
    await db.applySchema();
    pages = [[row(1, 'BP', 'New single family residence'), row(2, 'EP', 'Replace panel'), row(3, 'BP', 'New wood fence')]];
    await ingestArea('austin-tx', { days: 14, max: 100, allDetails: false });
    // Pretend the rows were scored by older rules.
    await db.query(`UPDATE permits SET trade_scores = '{"electrical": 95, "plumbing": 0, "hvac": 0}'::jsonb`);
    const { rows: [{ n: versionsBefore }] } = await db.query('SELECT count(*)::int AS n FROM permit_versions');

    const first = await rescoreAll({ batch: 2 });
    assert.deepStrictEqual([first.read, first.changed], [3, 3]);
    const { rows } = await db.query("SELECT permit_number, trade_scores FROM permits ORDER BY permit_number");
    const by = Object.fromEntries(rows.map((r) => [r.permit_number, r.trade_scores]));
    assert.ok(by['2026-1 BP'].electrical >= 90 && by['2026-1 BP'].plumbing >= 90, 'new home: every sub trade');
    assert.strictEqual(by['2026-2 EP'].electrical, 0, 'a trade permit is not a lead');
    assert.strictEqual(by['2026-3 BP'].electrical, 0, 'fence: site work only');

    const again = await rescoreAll({ batch: 2 });
    assert.strictEqual(again.changed, 0, 'a second run writes nothing');
    const { rows: [{ n: versionsAfter }] } = await db.query('SELECT count(*)::int AS n FROM permit_versions');
    assert.strictEqual(versionsAfter, versionsBefore, 'scores are not a permit change: no version rows');
    console.log('ok   - rescore rewrites changed scores only, idempotent, no version rows');
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
    global.fetch = realFetch;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
