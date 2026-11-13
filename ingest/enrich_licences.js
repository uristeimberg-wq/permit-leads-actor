// Licence verification run (ADR-15 item 1). Reads the Florida DBPR extracts
// and the Texas TDLR business licences, keeps only rows that can match one of
// our contractors, and links them (licence number, shown phone, or a unique
// business name in the same state). Each provider is its own sync_runs row
// with an error class; one failing does not stop the other (rule 3).
//
//   node ingest/enrich_licences.js [--provider=fl-dbpr|tx-tdlr]

const db = require('../db/index.js');
const L = require('../src/enrichment/licences.js');
const { normalizeName } = require('../src/contractors.js');
const { fetchWithRetry } = require('../src/adapters/http.js');
const { classifyError } = require('./raw.js');

const quiet = { info: () => {}, warning: (m) => console.error(`warning: ${m}`) };

async function loadContractors(state) {
  const { rows } = await db.query(`
    SELECT c.id, c.identity_key, c.normalized_name, c.party_kind,
           coalesce(array_agg(cp.value) FILTER (WHERE cp.kind = 'phone' AND cp.display_policy = 'show'), '{}') AS phones
      FROM contractors c LEFT JOIN contact_points cp ON cp.contractor_id = c.id
     WHERE split_part(c.identity_key, ':', 2) = $1
     GROUP BY c.id`, [state]);
  return rows.map((r) => ({ id: r.id, identityKey: r.identity_key, normalizedName: r.normalized_name, state,
    partyKind: r.party_kind, phones: r.phones }));
}

/** Keys a licence row could match on, so only those rows are kept. */
function wantedFor(contractors) {
  const lic = new Set();
  const names = new Set();
  const phones = new Set();
  for (const c of contractors) {
    if (c.identityKey.startsWith('lic:')) {
      const k = L.normalizeFlLicence(c.identityKey.split(':').slice(2).join(':'));
      if (k) lic.add(k);
    }
    if (c.partyKind === 'business') {
      names.add(c.normalizedName);
      for (const p of c.phones) phones.add(p);
    }
  }
  return (l) => lic.has(l.licenceKey) || (l.phone && phones.has(l.phone)) || names.has(normalizeName(l.businessName));
}

async function fetchOk(url, fetchImpl, init) {
  const res = await fetchWithRetry(fetchImpl, url, init, { log: quiet });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.slice(0, 120)}`);
  return res;
}

async function readDbpr(provider, keep, fetchImpl) {
  const out = [];
  let requests = 0;
  let rows = 0;
  let fileDate = null;
  for (const url of provider.files) {
    const res = await fetchOk(url, fetchImpl);
    requests += 1;
    const lm = res.headers && res.headers.get && res.headers.get('last-modified');
    if (lm && (!fileDate || new Date(lm) > fileDate)) fileDate = new Date(lm);
    for (const line of (await res.text()).split(/\r?\n/)) {
      if (!line.trim()) continue;
      rows += 1;
      const l = L.mapDbprRow(L.parseCsvLine(line));
      if (l && keep(l)) out.push(l);
    }
  }
  // A layout change would map nothing; that is a schema failure, not "0 matches".
  if (rows > 1000 && !out.length) throw new Error('schema: DBPR files parsed but no row had a usable licence number');
  return { licences: out, requests, rows, fileDate };
}

async function readTdlr(provider, keep, fetchImpl) {
  const headers = process.env.SOCRATA_APP_TOKEN ? { 'X-App-Token': process.env.SOCRATA_APP_TOKEN } : undefined;
  const meta = await (await fetchOk(provider.endpoint.replace('/resource/', '/api/views/'), fetchImpl, { headers })).json();
  let requests = 1;
  const fileDate = meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000) : null;
  const out = [];
  let rows = 0;
  const where = `license_type in(${provider.types.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')})`;
  for (let offset = 0; ; offset += 50000) {
    const q = new URLSearchParams({ $select: provider.columns.join(','), $where: where, $order: 'license_number', $limit: '50000', $offset: String(offset) });
    const page = await (await fetchOk(`${provider.endpoint}?${q}`, fetchImpl, { headers })).json();
    requests += 1;
    rows += page.length;
    for (const r of page) {
      const l = L.mapTdlrRow(r, provider);
      if (l && keep(l)) out.push(l);
    }
    if (page.length < 50000) break;
  }
  if (!rows) throw new Error('schema: TDLR returned no business licence rows');
  return { licences: out, requests, rows, fileDate };
}

async function writeProvider(slug, runId, licences, links, fileDate) {
  const pool = db.getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const col = (f) => licences.map((l) => (l[f] === undefined ? null : l[f]));
    await client.query(`
      INSERT INTO registry_licences (provider, licence_key, licence_number, licence_type, class_code, business_name, holder_name, city, state,
                            primary_status, secondary_status, expires_on, phone, file_date, fetched_at, sync_run_id)
      SELECT $1, t.*, $14, now(), $15 FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
             $9::char(2)[], $10::text[], $11::text[], $12::date[], $13::text[]) AS t
      ON CONFLICT (provider, licence_key) DO UPDATE SET
        licence_number = EXCLUDED.licence_number, licence_type = EXCLUDED.licence_type, class_code = EXCLUDED.class_code,
        business_name = EXCLUDED.business_name, holder_name = EXCLUDED.holder_name, city = EXCLUDED.city, state = EXCLUDED.state,
        primary_status = EXCLUDED.primary_status, secondary_status = EXCLUDED.secondary_status, expires_on = EXCLUDED.expires_on,
        phone = EXCLUDED.phone, file_date = EXCLUDED.file_date, fetched_at = now(), sync_run_id = EXCLUDED.sync_run_id`,
    [slug, col('licenceKey'), col('licenceNumber'), col('licenceType'), col('classCode'), col('businessName'), col('holderName'),
      col('city'), col('state'), col('primaryStatus'), col('secondaryStatus'), col('expiresOn'), col('phone'), fileDate, runId]);
    // A licence that dropped out of the file is no longer evidence of anything.
    await client.query('DELETE FROM registry_licences WHERE provider = $1 AND sync_run_id <> $2', [slug, runId]);
    await client.query('DELETE FROM contractor_registry_licences WHERE provider = $1', [slug]);
    const { rowCount } = await client.query(`
      INSERT INTO contractor_registry_licences (contractor_id, licence_id, provider, match_rule, match_confidence)
      SELECT t.contractor_id, l.id, $1, t.rule, t.conf
        FROM unnest($2::bigint[], $3::text[], $4::text[], $5::numeric[]) AS t(contractor_id, licence_key, rule, conf)
        JOIN registry_licences l ON l.provider = $1 AND l.licence_key = t.licence_key
      ON CONFLICT DO NOTHING`,
    [slug, links.map((m) => m.contractorId), links.map((m) => m.licenceKey), links.map((m) => m.rule), links.map((m) => m.confidence)]);
    await client.query('COMMIT');
    return rowCount;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function enrichLicences(slug, { fetchImpl = fetch, kind = 'scheduled' } = {}) {
  const provider = L.PROVIDERS[slug];
  if (!provider) throw new Error(`Unknown licence provider ${slug}`);
  const runId = await db.startSyncRun(await db.getSourceId(slug), kind);
  let requests = 0;
  try {
    const contractors = await loadContractors(provider.state);
    const keep = wantedFor(contractors);
    const read = slug === 'fl-dbpr' ? await readDbpr(provider, keep, fetchImpl) : await readTdlr(provider, keep, fetchImpl);
    requests = read.requests;
    const links = L.matchLicences(contractors, read.licences, provider.state);
    const linked = await writeProvider(slug, runId, read.licences, links, read.fileDate);
    const byRule = links.reduce((m, x) => ({ ...m, [x.rule]: (m[x.rule] || 0) + 1 }), {});
    await db.finishSyncRun(runId, { status: 'succeeded', requests, fetched: read.rows, newCount: read.licences.length });
    return { slug, rows: read.rows, kept: read.licences.length, contractors: contractors.length,
      contractorsLinked: new Set(links.map((x) => x.contractorId)).size, links: linked, byRule, fileDate: read.fileDate };
  } catch (err) {
    await db.finishSyncRun(runId, { status: 'failed', requests, errorClass: classifyError(err), errorDetail: String(err.stack || err.message).slice(0, 4000) });
    throw err;
  }
}

async function main() {
  const only = (process.argv.find((a) => a.startsWith('--provider=')) || '').split('=')[1];
  await db.applySchema();
  let failed = 0;
  for (const slug of only ? [only] : Object.keys(L.PROVIDERS)) {
    try {
      const s = await enrichLicences(slug);
      console.log(`Licences (${slug}): ${s.rows} rows read, ${s.kept} kept; ${s.contractorsLinked} of ${s.contractors} ${L.PROVIDERS[slug].state} `
        + `contractors linked (${JSON.stringify(s.byRule)}). File dated ${s.fileDate ? s.fileDate.toISOString().slice(0, 10) : 'unknown'}.`);
    } catch (err) {
      failed += 1;
      console.error(`Licences (${slug}) FAILED: ${err.message}`);
    }
  }
  // Coverage the licence chain adds where permits carry no phone (City of
  // Miami): businesses with their own shown phone vs one reached via licence.
  const { rows: [cov] } = await db.query(`
    WITH firms AS (
      SELECT DISTINCT c.id FROM contractors c JOIN permit_parties pp ON pp.contractor_id = c.id
        JOIN permits p ON p.id = pp.permit_id WHERE p.source_area = 'miami-city-fl' AND c.party_kind = 'business')
    SELECT count(*)::int AS firms,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contact_points cp WHERE cp.contractor_id = f.id AND cp.kind = 'phone' AND cp.display_policy = 'show'))::int AS own,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM contractor_registry_licences mine
               JOIN contractor_registry_licences theirs ON theirs.licence_id = mine.licence_id AND theirs.contractor_id <> mine.contractor_id AND theirs.match_rule = 'licence'
               JOIN contact_points cp ON cp.contractor_id = theirs.contractor_id AND cp.kind = 'phone' AND cp.display_policy = 'show'
              WHERE mine.contractor_id = f.id AND mine.match_rule = 'name_state'))::int AS via
      FROM firms f`);
  if (cov.firms) console.log(`City of Miami: ${cov.via} of ${cov.firms} businesses (${((100 * cov.via) / cov.firms).toFixed(1)}%) reach a phone through their licence; ${cov.own} have their own.`);
  await db.close();
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
}

module.exports = { enrichLicences, loadContractors, wantedFor };
