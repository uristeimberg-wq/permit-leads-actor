// Florida Sunbiz run (lane C): Florida contractor businesses against the
// Division of Corporations' corporate records (src/enrichment/sunbiz.js).
//
// Two kinds of file, both from the public SFTP (curl does the transfer):
//   - quarterly doc/Quarterly/Cor/cordata.zip: every record on file. A full
//     scan reads it and keeps the records whose name equals a Florida
//     contractor's normalised name, then decides every contractor name. Runs
//     when never run, when the file is newer than the last scan, or weekly so
//     that contractors first seen since then get decided.
//   - daily doc/cor/yyyymmddc.txt: that day's filings. Each file not yet
//     applied (registry_files) is read for entities we already hold and for
//     new entities that carry a decided name, and the affected names are
//     decided again. A missed day is caught up (last 45 days).
// Names first seen after the last full scan wait for the next one: a daily
// file alone cannot say that no older entity carries the name.
//
// Only business fields are kept; see the rules in src/enrichment/sunbiz.js.
// Every run is a sync_runs row for 'fl-sunbiz' (rule 3).
//
//   node ingest/enrich_sunbiz.js [--full] [--max-daily=30]

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const db = require('../db/index.js');
const S = require('../src/enrichment/sunbiz.js');
const { classifyError } = require('./raw.js');

// Published for public use on dos.fl.gov/sunbiz/other-services/data-downloads/.
const PUBLIC_LOGIN = 'Public:PubAccess1845!';
const ROOT = `sftp://${S.PROVIDER.host}/Public/`;
const FULL_EVERY_DAYS = 7;
const DAILY_LOOKBACK_DAYS = 45;

/** Runs a command; resolves with stdout (small outputs only). */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(0, 300)}`))));
  });
}

const curlArgs = ['-sS', '--retry', '3', '--retry-delay', '10', '-u', PUBLIC_LOGIN];

/** The real transfer layer; tests pass their own. */
const sftp = {
  /** [{ name, size, date }] for one folder (ls -l style listing). */
  async list(dir) {
    const text = await run('curl', [...curlArgs, '--max-time', '120', `${ROOT}${dir}/`]);
    return parseListing(text);
  },
  async download(file, to) {
    await run('curl', [...curlArgs, '--max-time', '3600', '-o', to, `${ROOT}${file}`]);
    return to;
  },
  /** Lines of a text file, or of every .txt inside a zip. */
  async *lines(localPath) {
    if (!/\.zip$/i.test(localPath)) { yield* readLines(fs.createReadStream(localPath, { encoding: 'latin1' })); return; }
    const inner = (await run('unzip', ['-Z1', localPath])).split('\n').map((s) => s.trim()).filter((s) => /\.txt$/i.test(s));
    for (const f of inner) {
      const p = spawn('unzip', ['-p', localPath, f], { stdio: ['ignore', 'pipe', 'inherit'] });
      p.stdout.setEncoding('latin1');
      yield* readLines(p.stdout);
    }
  },
};

async function* readLines(stream) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield line;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "-rw-r--r-- 1 nobody nobody 123 Nov 13 21:04 20261113c.txt" -> { name, size, date }. */
function parseListing(text, now = new Date()) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^[-dl][rwx-]{9}\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4}|\d{1,2}:\d{2})\s+(.+)$/);
    if (!m) continue;
    const mon = MONTHS[m[2].toLowerCase()];
    let year = /^\d{4}$/.test(m[4]) ? Number(m[4]) : now.getUTCFullYear();
    if (!/^\d{4}$/.test(m[4]) && mon > now.getUTCMonth() + 1) year -= 1; // "Dec 30 10:00" seen in January
    const date = mon ? `${year}-${String(mon).padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
    out.push({ name: m[5].trim(), size: Number(m[1]), date, dir: line.trim().startsWith('d') });
  }
  return out;
}

// ---------- database ----------

/** Florida business contractors' names to match (business only, rule 5). */
async function wantedNames() {
  const { rows } = await db.query(`
    SELECT DISTINCT normalized_name AS n FROM contractors
     WHERE business_state = 'FL' AND party_kind = 'business' AND permit_count > 0 AND length(normalized_name) >= 3`);
  return new Set(rows.map((r) => r.n));
}

async function decidedNames() {
  const { rows } = await db.query("SELECT query_key FROM registry_lookups WHERE provider = 'fl-sunbiz'");
  return new Set(rows.map((r) => r.query_key));
}

async function heldIds() {
  const { rows } = await db.query("SELECT registry_id FROM business_registrations WHERE provider = 'fl-sunbiz'");
  return new Set(rows.map((r) => r.registry_id));
}

const STATUS = { A: 'ACTIVE', I: 'INACTIVE' }; // the Division's own code list

async function saveRecords(runId, records, asOf) {
  if (!records.length) return 0;
  let written = 0;
  for (let i = 0; i < records.length; i += 500) {
    const b = records.slice(i, i + 500);
    const col = (f) => b.map(f);
    const { rowCount } = await db.query(`
      INSERT INTO business_registrations (provider, registry_id, legal_name, sos_file_number, state_of_formation, sos_status,
                                         sos_registered_on, report_year, mailing_city, mailing_state, mailing_zip,
                                         entity_type, principal_city, principal_state, principal_zip, last_transaction_on,
                                         source_as_of, name_key, fetched_at, sync_run_id)
      SELECT 'fl-sunbiz', t.*, now(), $17 FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::date[], $7::int[],
             $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::date[], $16::date[], $18::text[]) AS t
      ON CONFLICT (provider, registry_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, sos_file_number = EXCLUDED.sos_file_number,
        state_of_formation = EXCLUDED.state_of_formation, sos_status = EXCLUDED.sos_status, sos_registered_on = EXCLUDED.sos_registered_on,
        report_year = EXCLUDED.report_year, mailing_city = EXCLUDED.mailing_city, mailing_state = EXCLUDED.mailing_state,
        mailing_zip = EXCLUDED.mailing_zip, entity_type = EXCLUDED.entity_type, principal_city = EXCLUDED.principal_city,
        principal_state = EXCLUDED.principal_state, principal_zip = EXCLUDED.principal_zip,
        last_transaction_on = EXCLUDED.last_transaction_on, source_as_of = EXCLUDED.source_as_of, name_key = EXCLUDED.name_key,
        fetched_at = now(), sync_run_id = EXCLUDED.sync_run_id
      WHERE business_registrations.source_as_of IS NULL OR EXCLUDED.source_as_of >= business_registrations.source_as_of`,
    [col((r) => r.registryId), col((r) => r.legalName), col((r) => r.registryId), col((r) => r.stateOfFormation),
      col((r) => STATUS[r.status] || r.status), col((r) => r.filedOn), col((r) => r.reportYear), col((r) => r.mailingCity),
      col((r) => r.mailingState), col((r) => r.mailingZip), col((r) => r.filingType), col((r) => r.principalCity),
      col((r) => r.principalState), col((r) => r.principalZip), col((r) => r.lastTransactionOn), col(() => asOf), runId,
      col((r) => r.nameKey)]);
    written += rowCount;
  }
  return written;
}

/** Decides each name from the entities held for it; returns outcome counts. */
async function decide(runId, names) {
  const counts = { matched: 0, ambiguous: 0, none: 0 };
  if (!names.size) return counts;
  const { rows } = await db.query(`SELECT registry_id, sos_status, name_key FROM business_registrations
                                    WHERE provider = 'fl-sunbiz' AND name_key = ANY($1::text[])`, [[...names]]);
  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.name_key)) byName.set(r.name_key, []);
    byName.get(r.name_key).push({ registryId: r.registry_id, status: r.sos_status === 'ACTIVE' ? 'A' : 'I' });
  }
  const list = [...names];
  for (let i = 0; i < list.length; i += 1000) {
    const b = list.slice(i, i + 1000).map((n) => ({ n, ...S.pickEntity(byName.get(n)) }));
    for (const x of b) counts[x.outcome] += 1;
    await db.query(`
      INSERT INTO registry_lookups (provider, query_key, query_text, outcome, registry_id, candidates, looked_up_at, sync_run_id)
      SELECT 'fl-sunbiz', t.k, t.k, t.o, t.r, t.c, now(), $5 FROM unnest($1::text[], $2::text[], $3::text[], $4::int[]) AS t(k, o, r, c)
      ON CONFLICT (provider, query_key) DO UPDATE SET outcome = EXCLUDED.outcome, registry_id = EXCLUDED.registry_id,
        candidates = EXCLUDED.candidates, looked_up_at = now(), sync_run_id = EXCLUDED.sync_run_id`,
    [b.map((x) => x.n), b.map((x) => x.outcome), b.map((x) => x.registryId), b.map((x) => x.candidates), runId]);
  }
  return counts;
}

/** Links every Florida business contractor whose name has a matched lookup. */
async function relink() {
  return db.withTransaction(async (c) => {
    await c.query("DELETE FROM contractor_registrations WHERE provider = 'fl-sunbiz'");
    const { rowCount } = await c.query(`
      INSERT INTO contractor_registrations (contractor_id, registration_id, provider, match_rule, match_confidence)
      SELECT c.id, g.id, 'fl-sunbiz', CASE WHEN lu.candidates = 1 THEN 'name_state' ELSE 'name_state_active' END,
             CASE WHEN lu.candidates = 1 THEN 0.80 ELSE 0.75 END
        FROM registry_lookups lu
        JOIN business_registrations g ON g.provider = lu.provider AND g.registry_id = lu.registry_id
        JOIN contractors c ON c.normalized_name = lu.query_key AND c.business_state = 'FL' AND c.party_kind = 'business'
       WHERE lu.provider = 'fl-sunbiz' AND lu.outcome = 'matched'
      ON CONFLICT DO NOTHING`);
    return rowCount;
  });
}

async function applyFile(runId, io, { remote, fileName, fileDate, keep }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunbiz-'));
  try {
    const local = await io.download(remote, path.join(tmp, path.basename(remote)));
    const kept = new Map();
    let records = 0; let layoutFailed = 0;
    for await (const line of io.lines(local)) {
      records += 1;
      const r = keep(line);
      if (r === false) layoutFailed += 1;
      else if (r) kept.set(r.registryId, r);
    }
    // A file that mostly fails the layout check means the layout moved:
    // store nothing from it (rule 1) and fail loudly (rule 3).
    if (records && layoutFailed / records > 0.02) {
      throw new Error(`schema: ${layoutFailed} of ${records} lines in ${fileName} fail the Sunbiz layout check`);
    }
    const written = await saveRecords(runId, [...kept.values()], fileDate);
    await db.query(`INSERT INTO registry_files (provider, file_name, file_date, records, kept, layout_failed, sync_run_id)
                    VALUES ('fl-sunbiz', $1, $2, $3, $4, $5, $6)
                    ON CONFLICT (provider, file_name) DO UPDATE SET records = EXCLUDED.records, kept = EXCLUDED.kept,
                      layout_failed = EXCLUDED.layout_failed, applied_at = now(), sync_run_id = EXCLUDED.sync_run_id`,
    [fileName, fileDate, records, kept.size, layoutFailed, runId]);
    return { records, kept: kept.size, written, layoutFailed, names: new Set([...kept.values()].map((r) => r.nameKey)) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** A line -> the kept record, null (not wanted) or false (fails the layout). */
function keeper(select) {
  return (line) => {
    const checks = S.checkRecord(line);
    if (!checks.length1440 || !checks.number || !checks.status || !checks.fileDate) return false;
    return select(line);
  };
}

async function enrichSunbiz({ io = sftp, full = false, maxDaily = 30, kind = 'scheduled', now = new Date() } = {}) {
  const sourceId = await db.getSourceId(S.PROVIDER.slug);
  const runId = await db.startSyncRun(sourceId, kind);
  const stats = { full: null, daily: [], decided: null, linked: 0, pendingNames: 0, requests: 0 };
  try {
    const wanted = await wantedNames();
    // Full scan: due when never done, when the quarterly file is newer than
    // the last scan, or weekly.
    const [qdir, qname] = [path.dirname(S.PROVIDER.quarterlyFile), path.basename(S.PROVIDER.quarterlyFile)];
    const listing = await io.list(qdir); stats.requests += 1;
    const q = listing.find((f) => f.name === qname);
    if (!q) throw new Error(`schema: ${S.PROVIDER.quarterlyFile} is not on the server`);
    const { rows: [last] } = await db.query(`SELECT max(applied_at) AS at, to_char(max(file_date), 'YYYY-MM-DD') AS file_date
                                               FROM registry_files WHERE provider = 'fl-sunbiz' AND file_name LIKE 'quarterly:%'`);
    const due = full || !last.at || (q.date && last.file_date && q.date > last.file_date)
      || (now - new Date(last.at)) / 86400000 >= FULL_EVERY_DAYS;
    if (due) {
      const r = await applyFile(runId, io, {
        remote: S.PROVIDER.quarterlyFile, fileName: `quarterly:${qname}@${q.date || 'undated'}`, fileDate: q.date,
        keep: keeper(S.selector({ names: wanted })),
      });
      stats.requests += 1;
      stats.full = { records: r.records, kept: r.kept, layoutFailed: r.layoutFailed };
    }
    // Daily files since the lookback, oldest first, each once.
    const dailies = (await io.list(S.PROVIDER.dailyDir)).filter((f) => S.dailyFileDate(f.name)); stats.requests += 1;
    const since = new Date(now.getTime() - DAILY_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
    const { rows: done } = await db.query("SELECT file_name FROM registry_files WHERE provider = 'fl-sunbiz'");
    const applied = new Set(done.map((r) => r.file_name));
    const todo = dailies.map((f) => ({ ...f, day: S.dailyFileDate(f.name) }))
      .filter((f) => f.day >= since && !applied.has(f.name)).sort((a, b) => a.day.localeCompare(b.day)).slice(0, maxDaily);
    // After a full scan every wanted name counts as decided for the dailies.
    const decided = due ? wanted : await decidedNames();
    const touched = new Set();
    for (const f of todo) {
      const ids = await heldIds();
      const r = await applyFile(runId, io, {
        remote: `${S.PROVIDER.dailyDir}/${f.name}`, fileName: f.name, fileDate: f.day,
        keep: keeper(S.selector({ names: decided, ids })),
      });
      stats.requests += 1;
      for (const n of r.names) touched.add(n);
      stats.daily.push({ file: f.name, records: r.records, kept: r.kept });
    }
    // Names an updated entity used to carry are decided again too.
    if (due) stats.decided = await decide(runId, wanted);
    else if (touched.size) {
      const re = new Set([...touched].filter((n) => decided.has(n)));
      const { rows } = await db.query(`SELECT query_key FROM registry_lookups WHERE provider = 'fl-sunbiz' AND registry_id IN
                                         (SELECT registry_id FROM business_registrations WHERE provider = 'fl-sunbiz' AND sync_run_id = $1)`, [runId]);
      for (const r of rows) re.add(r.query_key);
      stats.decided = await decide(runId, re);
    }
    stats.linked = await relink();
    const decidedNow = await decidedNames();
    stats.pendingNames = [...wanted].filter((n) => !decidedNow.has(n)).length;
    await db.finishSyncRun(runId, {
      status: 'succeeded', requests: stats.requests,
      fetched: (stats.full ? stats.full.records : 0) + stats.daily.reduce((a, d) => a + d.records, 0),
      newCount: stats.decided ? stats.decided.matched : 0, changed: 0, failed: 0,
    });
    return stats;
  } catch (err) {
    const errorClass = /^schema:/.test(err.message) ? 'schema' : classifyError(err);
    await db.finishSyncRun(runId, { status: 'failed', requests: stats.requests, errorClass, errorDetail: String(err.stack || err.message).slice(0, 4000) });
    throw err;
  }
}

async function coverage() {
  const { rows: [r] } = await db.query(`
    SELECT count(*)::int AS businesses,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM registry_lookups lu WHERE lu.provider = 'fl-sunbiz' AND lu.query_key = c.normalized_name))::int AS decided,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contractor_registrations x WHERE x.contractor_id = c.id AND x.provider = 'fl-sunbiz'))::int AS verified,
           coalesce(sum(c.permit_count), 0)::int AS permits,
           coalesce(sum(c.permit_count) FILTER (WHERE EXISTS (SELECT 1 FROM contractor_registrations x WHERE x.contractor_id = c.id AND x.provider = 'fl-sunbiz')), 0)::int AS verified_permits
      FROM contractors c WHERE c.business_state = 'FL' AND c.party_kind = 'business' AND c.permit_count > 0`);
  const { rows: outcomes } = await db.query("SELECT outcome, count(*)::int AS n FROM registry_lookups WHERE provider = 'fl-sunbiz' GROUP BY 1 ORDER BY 2 DESC");
  const { rows: status } = await db.query(`
    SELECT coalesce(g.sos_status, 'not stated') AS s, count(DISTINCT cr.contractor_id)::int AS n
      FROM contractor_registrations cr JOIN business_registrations g ON g.id = cr.registration_id
     WHERE cr.provider = 'fl-sunbiz' GROUP BY 1 ORDER BY 2 DESC`);
  return { ...r, outcomes, status };
}

async function main() {
  const arg = (n, d) => { const a = process.argv.find((x) => x === `--${n}` || x.startsWith(`--${n}=`)); return a ? (a.split('=')[1] ?? true) : d; };
  await db.applySchema();
  const s = await enrichSunbiz({ full: Boolean(arg('full', false)), maxDaily: Number(arg('max-daily', 30)) });
  const c = await coverage();
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
  console.log([
    '## Florida business entities (Sunbiz)', '',
    s.full ? `Full scan: ${s.full.records} records read, ${s.full.kept} kept (names equal to a Florida contractor's), ${s.full.layoutFailed} failed the layout check.`
      : 'Full scan: not due.',
    `Daily files applied: ${s.daily.length ? s.daily.map((d) => `${d.file} (${d.records} read, ${d.kept} kept)`).join(', ') : 'none new'}.`,
    s.decided ? `Names decided this run: matched ${s.decided.matched}, ambiguous ${s.decided.ambiguous}, none ${s.decided.none}.` : '',
    `All names so far: ${c.outcomes.map((o) => `${o.outcome} ${o.n}`).join(', ') || 'none'}; ${s.pendingNames} names wait for the next full scan.`,
    `Florida business contractors: ${c.businesses}; decided ${c.decided} (${pct(c.decided, c.businesses)}); `
      + `tied to one Sunbiz entity ${c.verified} (${pct(c.verified, c.businesses)}), holding ${pct(c.verified_permits, c.permits)} of their permits.`,
    `Status of linked entities: ${c.status.map((x) => `${x.s} ${x.n}`).join(', ') || 'n/a'}.`,
  ].filter(Boolean).join('\n'));
  await db.close();
}

if (require.main === module) {
  main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
}

module.exports = { enrichSunbiz, coverage, parseListing, keeper, sftpForRecon: { lines: (p) => sftp.lines(p) } };
