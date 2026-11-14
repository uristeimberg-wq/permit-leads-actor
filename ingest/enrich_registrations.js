// Business registration run (ADR-23 sprint 2): Texas contractor businesses
// against the Comptroller's franchise-tax records (src/enrichment/registrations.js).
//
// - One lookup per normalised business name; names never asked come first,
//   then the stalest, most-used first. A run stops at --max names or
//   --minutes, so the backlog is worked through over several days without
//   holding up the sync.
// - Requests are spaced (PROVIDER.minIntervalMs) and a 429 backs off; a name
//   that keeps failing is stored as 'error' and retried the next day.
// - Every run is a sync_runs row for 'tx-comptroller' (rule 3).
// - Without TX_COMPTROLLER_API_KEY it does nothing and says so.
//
//   node ingest/enrich_registrations.js [--max=600] [--minutes=20]

const db = require('../db/index.js');
const R = require('../src/enrichment/registrations.js');
const { classifyError } = require('./raw.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client({ key, fetchImpl = fetch, minIntervalMs = R.PROVIDER.minIntervalMs, backoffMs = [5000, 15000, 45000] }) {
  let last = 0;
  let requests = 0;
  async function get(path) {
    for (let attempt = 0; ; attempt += 1) {
      const wait = minIntervalMs - (Date.now() - last);
      if (wait > 0) await sleep(wait);
      last = Date.now();
      requests += 1;
      const res = await fetchImpl(`${R.PROVIDER.base}${path}`, { headers: { 'x-api-key': key, Accept: 'application/json' } });
      if (res.status === 429 && attempt < backoffMs.length) { await sleep(backoffMs[attempt]); continue; }
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${path.split('?')[0]}`);
      if (body && body.success === false) throw new Error(`API error from ${path.split('?')[0]}`);
      return body;
    }
  }
  return { get, requests: () => requests };
}

async function due(provider, max) {
  const r = provider.refreshDays;
  const { rows } = await db.query(`
    SELECT c.normalized_name AS key, sum(c.permit_count)::int AS permits, lu.outcome
      FROM contractors c
      LEFT JOIN registry_lookups lu ON lu.provider = $1 AND lu.query_key = c.normalized_name
     WHERE c.business_state = 'TX' AND c.party_kind = 'business' AND c.permit_count > 0 AND length(c.normalized_name) >= 3
       AND (lu.query_key IS NULL OR lu.looked_up_at < now() - make_interval(days => CASE lu.outcome
             WHEN 'matched' THEN $2::int WHEN 'none' THEN $3::int WHEN 'ambiguous' THEN $4::int WHEN 'prefix' THEN $5::int ELSE $6::int END))
     GROUP BY c.normalized_name, lu.query_key, lu.outcome, lu.looked_up_at
     ORDER BY (lu.query_key IS NULL) DESC, lu.looked_up_at NULLS FIRST, sum(c.permit_count) DESC, c.normalized_name
     LIMIT $7`, [provider.slug, r.matched, r.none, r.ambiguous, r.prefix, r.error, max]);
  return rows;
}

async function saveLookup(runId, l) {
  await db.query(`
    INSERT INTO registry_lookups (provider, query_key, query_text, outcome, registry_id, candidates, error_detail, looked_up_at, sync_run_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
    ON CONFLICT (provider, query_key) DO UPDATE SET query_text = EXCLUDED.query_text, outcome = EXCLUDED.outcome,
      registry_id = EXCLUDED.registry_id, candidates = EXCLUDED.candidates, error_detail = EXCLUDED.error_detail,
      looked_up_at = now(), sync_run_id = EXCLUDED.sync_run_id`,
  [R.PROVIDER.slug, l.key, l.queryText, l.outcome, l.registryId || null, l.candidates ?? null, l.error || null, runId]);
}

async function saveRegistration(runId, g) {
  await db.query(`
    INSERT INTO business_registrations (provider, registry_id, legal_name, dba_name, sos_file_number, state_of_formation, sos_status,
                                       right_to_transact, sos_registered_on, report_year, mailing_city, mailing_state, mailing_zip,
                                       fetched_at, sync_run_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), $14)
    ON CONFLICT (provider, registry_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, dba_name = EXCLUDED.dba_name,
      sos_file_number = EXCLUDED.sos_file_number, state_of_formation = EXCLUDED.state_of_formation, sos_status = EXCLUDED.sos_status,
      right_to_transact = EXCLUDED.right_to_transact, sos_registered_on = EXCLUDED.sos_registered_on, report_year = EXCLUDED.report_year,
      mailing_city = EXCLUDED.mailing_city, mailing_state = EXCLUDED.mailing_state, mailing_zip = EXCLUDED.mailing_zip,
      fetched_at = now(), sync_run_id = EXCLUDED.sync_run_id`,
  [R.PROVIDER.slug, g.registryId, g.legalName, g.dbaName, g.sosFileNumber, g.stateOfFormation, g.sosStatus, g.rightToTransact,
    g.sosRegisteredOn, g.reportYear, g.mailingCity, g.mailingState, g.mailingZip, runId]);
}

/** Links every Texas business contractor whose name has a matched lookup. */
async function relink() {
  return db.withTransaction(async (c) => {
    await c.query('DELETE FROM contractor_registrations WHERE provider = $1', [R.PROVIDER.slug]);
    const { rowCount } = await c.query(`
      INSERT INTO contractor_registrations (contractor_id, registration_id, provider, match_rule, match_confidence)
      SELECT c.id, g.id, $1, 'name_state', 0.80
        FROM registry_lookups lu
        JOIN business_registrations g ON g.provider = lu.provider AND g.registry_id = lu.registry_id
        JOIN contractors c ON c.normalized_name = lu.query_key AND c.business_state = 'TX' AND c.party_kind = 'business'
       WHERE lu.provider = $1 AND lu.outcome = 'matched'
      ON CONFLICT DO NOTHING`, [R.PROVIDER.slug]);
    return rowCount;
  });
}

async function enrichRegistrations({ key = process.env.TX_COMPTROLLER_API_KEY, max = 600, minutes = 20, fetchImpl, minIntervalMs, backoffMs, kind = 'scheduled' } = {}) {
  if (!key) return { skipped: 'TX_COMPTROLLER_API_KEY is not set' };
  const sourceId = await db.getSourceId(R.PROVIDER.slug);
  const runId = await db.startSyncRun(sourceId, kind);
  const api = client({ key, fetchImpl, minIntervalMs, backoffMs });
  const deadline = Date.now() + minutes * 60000;
  const counts = { matched: 0, ambiguous: 0, prefix: 0, none: 0, error: 0 };
  let consecutiveErrors = 0;
  let stoppedBy = null;
  try {
    const todo = await due(R.PROVIDER, max);
    for (const t of todo) {
      if (Date.now() > deadline) { stoppedBy = 'time budget'; break; }
      const queryText = R.searchText(t.key);
      try {
        const body = await api.get(`/franchise-tax-list?name=${encodeURIComponent(queryText)}`);
        const m = R.pickMatch(t.key, body);
        if (m.outcome === 'matched') {
          const reg = R.mapDetail(await api.get(`/franchise-tax/${encodeURIComponent(m.taxpayerId)}`));
          if (!reg) throw new Error('bad_data: empty franchise-tax detail');
          await saveRegistration(runId, reg);
        }
        await saveLookup(runId, { key: t.key, queryText, outcome: m.outcome, registryId: m.taxpayerId, candidates: m.candidates });
        counts[m.outcome] += 1;
        consecutiveErrors = 0;
      } catch (err) {
        counts.error += 1;
        consecutiveErrors += 1;
        await saveLookup(runId, { key: t.key, queryText, outcome: 'error', error: String(err.message).slice(0, 300) });
        if (/HTTP 40[13]/.test(err.message)) throw err; // the key is wrong: stop and say so
        if (consecutiveErrors >= 5) { stoppedBy = `5 errors in a row (last: ${err.message})`; break; }
      }
    }
    const linked = await relink();
    const looked = Object.values(counts).reduce((a, b) => a + b, 0);
    const stats = { looked, ...counts, linked, requests: api.requests(), backlog: todo.length - looked, stoppedBy };
    // Every lookup failing is a failed run; some failing is a partial one,
    // counted in records_failed and retried tomorrow.
    const failedRun = counts.error > 0 && counts.error === looked;
    await db.finishSyncRun(runId, {
      status: failedRun ? 'failed' : 'succeeded',
      requests: api.requests(), fetched: looked, newCount: counts.matched, changed: 0, failed: counts.error,
      errorClass: failedRun ? classifyError(new Error(stoppedBy || 'HTTP 429')) : null,
      errorDetail: stoppedBy || (counts.error ? `${counts.error} lookups failed` : null),
    });
    return stats;
  } catch (err) {
    await db.finishSyncRun(runId, { status: 'failed', requests: api.requests(), errorClass: classifyError(err), errorDetail: String(err.stack || err.message).slice(0, 4000) });
    throw err;
  }
}

/** Coverage of Texas business contractors and of the Austin permits they hold. */
async function coverage() {
  const { rows: [r] } = await db.query(`
    SELECT count(*)::int AS businesses,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM registry_lookups lu WHERE lu.provider = $1 AND lu.query_key = c.normalized_name AND lu.outcome <> 'error'))::int AS looked,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contractor_registrations x WHERE x.contractor_id = c.id))::int AS verified,
           coalesce(sum(c.permit_count), 0)::int AS permits,
           coalesce(sum(c.permit_count) FILTER (WHERE EXISTS (SELECT 1 FROM contractor_registrations x WHERE x.contractor_id = c.id)), 0)::int AS verified_permits,
           coalesce(sum(c.permit_count) FILTER (WHERE EXISTS (SELECT 1 FROM registry_lookups lu WHERE lu.provider = $1 AND lu.query_key = c.normalized_name AND lu.outcome <> 'error')), 0)::int AS looked_permits
      FROM contractors c WHERE c.business_state = 'TX' AND c.party_kind = 'business' AND c.permit_count > 0`, [R.PROVIDER.slug]);
  const { rows: outcomes } = await db.query('SELECT outcome, count(*)::int AS n FROM registry_lookups WHERE provider = $1 GROUP BY 1 ORDER BY 2 DESC', [R.PROVIDER.slug]);
  const { rows: status } = await db.query(`
    SELECT coalesce(g.right_to_transact, 'not stated') AS s, count(DISTINCT cr.contractor_id)::int AS n
      FROM contractor_registrations cr JOIN business_registrations g ON g.id = cr.registration_id GROUP BY 1 ORDER BY 2 DESC`);
  return { ...r, outcomes, status };
}

async function main() {
  const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
  await db.applySchema();
  const s = await enrichRegistrations({ max: Number(arg('max', 600)), minutes: Number(arg('minutes', 20)) });
  if (s.skipped) { console.log(`Business registrations: skipped (${s.skipped}).`); await db.close(); return; }
  const c = await coverage();
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
  console.log([
    '## Texas business registrations (Comptroller)', '',
    `This run: ${s.looked} names looked up (${s.matched} matched, ${s.ambiguous} ambiguous, ${s.prefix} prefix only, ${s.none} none, ${s.error} errors), `
      + `${s.requests} requests, ${s.linked} contractors linked${s.stoppedBy ? `; stopped: ${s.stoppedBy}` : ''}.`,
    `All lookups so far: ${c.outcomes.map((o) => `${o.outcome} ${o.n}`).join(', ')}.`,
    `Texas business contractors: ${c.businesses}; looked up ${c.looked} (${pct(c.looked, c.businesses)}); `
      + `verified ${c.verified} (${pct(c.verified, c.looked)} of those looked up, ${pct(c.verified, c.businesses)} of all).`,
    `By permits held: ${pct(c.verified_permits, c.looked_permits)} of looked-up contractors' permits are with a verified business `
      + `(${pct(c.looked_permits, c.permits)} of permits looked up so far).`,
    `Right to transact in Texas, verified contractors: ${c.status.map((x) => `${x.s} ${x.n}`).join(', ') || 'n/a'}.`,
  ].join('\n'));
  await db.close();
}

if (require.main === module) {
  main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
}

module.exports = { enrichRegistrations, coverage, client };
