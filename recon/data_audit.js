// Read-only audit of what the live database actually holds, per market:
// field fill rates, provenance (raw record behind each permit), freshness and
// publication lag, links, enrichment coverage, contacts, duplicates and sync
// reliability. Prints Markdown; writes nothing. Baseline for the data-quality
// scorecard in docs/DATA_ENGINE_PLAN.md.
//
//   DATABASE_URL=... node recon/data_audit.js
//
// Every connection is set read-only before its first query, and each section
// runs on its own so one failure is reported and the rest still print.

const db = require('../db/index.js');

db.getPool().on('connect', (c) => {
  c.query("SET default_transaction_read_only = on; SET statement_timeout = '180s'").catch(() => {});
});

const q = async (sql, p) => (await db.query(sql, p)).rows;
const pct = (n, d) => (d ? `${(Math.round((1000 * Number(n)) / Number(d)) / 10).toFixed(1)}%` : 'n/a');
const out = (s = '') => process.stdout.write(`${s}\n`);
const table = (head, rows) => {
  out(`| ${head.join(' | ')} |`);
  out(`|${head.map(() => '---').join('|')}|`);
  for (const r of rows) out(`| ${r.map((x) => (x == null ? '' : String(x).replace(/\|/g, '/'))).join(' | ')} |`);
  out();
};

// Columns that are derived, internal or not a "field" a customer would see.
const SKIP_COLS = new Set(['id', 'source_area', 'permit_number', 'search_tsv', 'content_hash']);

async function section(title, fn) {
  out(`## ${title}`);
  out();
  const t0 = Date.now();
  try {
    await fn();
  } catch (err) {
    out(`_Section failed: ${err.code || ''} ${err.message}_`);
    out();
  }
  process.stderr.write(`${title}: ${Date.now() - t0} ms\n`);
}

async function main() {
  out(`# Data audit, ${new Date().toISOString()}`);
  out();
  const markets = (await q('SELECT source_area, count(*)::int AS n FROM permits GROUP BY 1 ORDER BY 2 DESC'));

  await section('Size and shape', async () => {
    const sz = await q(`SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS size, c.reltuples::bigint AS est_rows
                          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = 'public' AND c.relkind = 'r'
                         ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 25`);
    const [{ total }] = await q('SELECT pg_size_pretty(pg_database_size(current_database())) AS total');
    out(`Database size: ${total}`);
    out();
    table(['table', 'size', 'est. rows'], sz.map((r) => [r.relname, r.size, r.est_rows]));
    const shape = await q(`SELECT source_area, coalesce(filing_kind, 'permit') AS kind, lifecycle_stage, count(*)::int AS n
                             FROM permits GROUP BY 1, 2, 3 ORDER BY 1, 2, 4 DESC`);
    table(['market', 'kind', 'lifecycle stage', 'rows'], shape.map((r) => [r.source_area, r.kind, r.lifecycle_stage, r.n]));
  });

  await section('Field fill rates on permits (non-empty share, per market)', async () => {
    const cols = (await q(`SELECT column_name, data_type FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'permits' ORDER BY ordinal_position`))
      .filter((c) => !SKIP_COLS.has(c.column_name));
    const exprs = cols.map((c, i) => {
      const col = `"${c.column_name}"`;
      let cond = `${col} IS NOT NULL`;
      if (['text', 'character varying', 'character'].includes(c.data_type)) cond += ` AND btrim(${col}) <> ''`;
      if (c.data_type === 'jsonb') cond += ` AND ${col} NOT IN ('{}'::jsonb, '[]'::jsonb, 'null'::jsonb)`;
      if (c.data_type === 'numeric') cond += ` AND ${col} <> 0`;
      return `count(*) FILTER (WHERE ${cond})::int AS c${i}`;
    });
    const rows = await q(`SELECT source_area, count(*)::int AS n, ${exprs.join(', ')} FROM permits GROUP BY 1 ORDER BY 2 DESC`);
    const head = ['field', ...rows.map((r) => `${r.source_area} (${r.n})`)];
    table(head, cols.map((c, i) => [c.column_name, ...rows.map((r) => pct(r[`c${i}`], r.n))]));
    out('Numeric columns count 0 as empty (valuation 0 is a placeholder in several sources).');
    out();
  });

  await section('Provenance: raw record behind each permit', async () => {
    const rows = await q(`
      SELECT p.source_area, count(*)::int AS n,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM raw_records rr WHERE rr.source_id = s.id AND rr.source_key = p.permit_number))::int AS with_raw,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM permit_versions v WHERE v.permit_id = p.id))::int AS with_version,
             round(avg((SELECT count(*) FROM permit_versions v WHERE v.permit_id = p.id)), 2) AS avg_versions
        FROM permits p LEFT JOIN sources s ON s.slug = p.source_area
       GROUP BY 1 ORDER BY 2 DESC`);
    table(['market', 'permits', 'with raw record', 'with ≥1 version', 'avg versions'],
      rows.map((r) => [r.source_area, r.n, pct(r.with_raw, r.n), pct(r.with_version, r.n), r.avg_versions]));
    const raw = await q(`SELECT s.slug, count(*)::int AS n, count(*) FILTER (WHERE rr.normalize_error IS NOT NULL)::int AS errs,
                                min(rr.fetched_at)::date::text AS first, max(rr.fetched_at)::date::text AS last
                           FROM raw_records rr JOIN sources s ON s.id = rr.source_id GROUP BY 1 ORDER BY 2 DESC`);
    table(['source', 'raw records', 'normalize errors', 'first fetched', 'last fetched'],
      raw.map((r) => [r.slug, r.n, r.errs, r.first, r.last]));
  });

  await section('Source fields we receive but do not map (raw payload keys, latest 2,000 per source)', async () => {
    const srcs = await q("SELECT id, slug FROM sources WHERE enabled ORDER BY slug");
    for (const s of srcs) {
      const keys = await q(`
        WITH sample AS (SELECT payload FROM raw_records WHERE source_id = $1 ORDER BY id DESC LIMIT 2000)
        SELECT k, count(*)::int AS n,
               count(*) FILTER (WHERE v IS NOT NULL AND v <> 'null'::jsonb AND btrim(v #>> '{}') NOT IN ('', '0', '0000000000'))::int AS filled
          FROM sample, jsonb_each(payload) AS e(k, v) GROUP BY k ORDER BY k`, [s.id]);
      if (!keys.length) continue;
      const [{ n }] = await q('SELECT count(*)::int AS n FROM (SELECT 1 FROM raw_records WHERE source_id = $1 ORDER BY id DESC LIMIT 2000) x', [s.id]);
      out(`**${s.slug}** (${n} sampled, ${keys.length} keys): ${keys.map((k) => `${k.k} ${pct(k.filled, n)}`).join(', ')}`);
      out();
    }
  });

  await section('Freshness and publication lag', async () => {
    const runs = await q(`
      SELECT s.slug, s.enabled,
             max(r.finished_at) FILTER (WHERE r.status = 'succeeded')::text AS last_ok,
             count(*) FILTER (WHERE r.started_at > now() - interval '30 days')::int AS runs30,
             count(*) FILTER (WHERE r.started_at > now() - interval '30 days' AND r.status = 'succeeded')::int AS ok30,
             string_agg(DISTINCT r.error_class, ',') FILTER (WHERE r.started_at > now() - interval '30 days') AS errs
        FROM sources s LEFT JOIN sync_runs r ON r.source_id = s.id GROUP BY 1, 2 ORDER BY 1`);
    table(['source', 'enabled', 'last success', 'runs 30 d', 'success 30 d', 'error classes'],
      runs.map((r) => [r.slug, r.enabled, r.last_ok, r.runs30, pct(r.ok30, r.runs30), r.errs]));
    // Lag = when we first saw a row minus the source's own date for it. Only
    // "forward" rows count: the source dates it on or after the day we started
    // syncing that market, so backfilled history does not pose as lag.
    const lag = await q(`
      WITH start AS (SELECT source_area, min(first_seen_at)::date AS d FROM permits GROUP BY 1)
      SELECT source_area, coalesce(filing_kind, 'permit') AS kind, count(*)::int AS n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY first_seen_at::date - coalesce(submitted_on, filed_date)) AS p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY first_seen_at::date - coalesce(submitted_on, filed_date)) AS p90,
             max(first_seen_at)::text AS newest_seen, max(coalesce(submitted_on, filed_date))::text AS newest_date
        FROM permits JOIN start USING (source_area)
       WHERE coalesce(submitted_on, filed_date) >= start.d
         AND first_seen_at::date >= coalesce(submitted_on, filed_date)
       GROUP BY 1, 2 ORDER BY 1, 2`);
    table(['market', 'kind', 'forward rows (dated on/after our first sync)', 'lag p50 (days)', 'lag p90', 'newest first_seen', 'newest source date'],
      lag.map((r) => [r.source_area, r.kind, r.n, r.p50, r.p90, r.newest_seen, r.newest_date]));
    out('Lag uses submitted_on for applications and filed_date for permits; filed_date means different things per source (DATA_SOURCES.md), so compare markets with care.');
    out();
    const stageLag = await q(`
      WITH start AS (SELECT source_area, min(first_seen_at)::date AS d FROM permits GROUP BY 1)
      SELECT source_area, lifecycle_stage, count(*)::int AS n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY last_changed_at::date - stage_since) AS p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY last_changed_at::date - stage_since) AS p90
        FROM permits JOIN start USING (source_area)
       WHERE stage_since >= start.d AND last_changed_at::date >= stage_since
       GROUP BY 1, 2 ORDER BY 1, 3 DESC`);
    table(['market', 'stage', 'stage changes dated after our first sync', 'seen lag p50 (days)', 'p90'],
      stageLag.map((r) => [r.source_area, r.lifecycle_stage, r.n, r.p50, r.p90]));
    const hist = await q(`SELECT s.slug, min(r.started_at)::date::text AS first_run, count(*)::int AS runs
                            FROM sync_runs r JOIN sources s ON s.id = r.source_id GROUP BY 1 ORDER BY 1`);
    table(['source', 'first sync run', 'runs ever'], hist.map((r) => [r.slug, r.first_run, r.runs]));
  });

  await section('Contractor identification (building/trade permits)', async () => {
    const rows = await q(`
      SELECT p.source_area, count(*)::int AS n,
             count(*) FILTER (WHERE pp.permit_id IS NOT NULL)::int AS with_party,
             count(*) FILTER (WHERE pp.contractor_id IS NOT NULL)::int AS resolved,
             count(*) FILTER (WHERE pp.match_rule = 'licence')::int AS by_licence,
             count(*) FILTER (WHERE pp.match_rule = 'name_state')::int AS by_name,
             count(*) FILTER (WHERE pp.match_rule = 'owner_builder')::int AS owner_builder,
             count(*) FILTER (WHERE pp.match_rule = 'unresolved')::int AS unresolved
        FROM permits p LEFT JOIN permit_parties pp ON pp.permit_id = p.id
       WHERE p.filing_kind IS NULL GROUP BY 1 ORDER BY 2 DESC`);
    table(['market', 'permits', 'contractor named', 'resolved to entity', 'by licence', 'by name+state', 'owner-builder', 'unresolved'],
      rows.map((r) => [r.source_area, r.n, pct(r.with_party, r.n), pct(r.resolved, r.n), pct(r.by_licence, r.n), pct(r.by_name, r.n), pct(r.owner_builder, r.n), pct(r.unresolved, r.n)]));
    const ent = await q(`
      SELECT c.business_state AS st, c.party_kind, count(*)::int AS n,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contact_points cp WHERE cp.contractor_id = c.id AND cp.kind = 'phone'))::int AS phone,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contact_points cp WHERE cp.contractor_id = c.id AND cp.kind = 'phone' AND cp.display_policy = 'show'))::int AS phone_show,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contact_points cp WHERE cp.contractor_id = c.id AND cp.kind = 'phone' AND cp.verification <> 'unverified'))::int AS phone_corr,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contact_points cp WHERE cp.contractor_id = c.id AND cp.kind IN ('email', 'website')))::int AS web,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contractor_registry_licences l WHERE l.contractor_id = c.id))::int AS lic,
             count(*) FILTER (WHERE c.permit_count >= 2)::int AS repeat
        FROM contractors c GROUP BY 1, 2 ORDER BY 1, 3 DESC`);
    table(['state', 'party kind', 'entities', 'any phone', 'phone shown', 'phone corroborated', 'email/website', 'state licence linked', '≥2 permits'],
      ent.map((r) => [r.st, r.party_kind, r.n, pct(r.phone, r.n), pct(r.phone_show, r.n), pct(r.phone_corr, r.n), pct(r.web, r.n), pct(r.lic, r.n), pct(r.repeat, r.n)]));
    const rel = await q('SELECT count(*)::int AS n FROM contractor_relationships');
    out(`contractor_relationships rows: ${rel[0].n}`);
    out();
    const fil = await q(`
      SELECT p.source_area, count(*)::int AS n, count(DISTINCT ff.permit_id)::int AS with_filer
        FROM permits p LEFT JOIN filing_filers ff ON ff.permit_id = p.id
       WHERE p.filing_kind IS NOT NULL GROUP BY 1`);
    table(['market', 'applications', 'filer organisation named'], fil.map((r) => [r.source_area, r.n, pct(r.with_filer, r.n)]));
  });

  await section('Property and location enrichment', async () => {
    const link = await q(`
      SELECT p.source_area, count(*)::int AS n,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM permit_parcels x WHERE x.permit_id = p.id))::int AS parcel,
             count(*) FILTER (WHERE l.method = 'source')::int AS loc_source,
             count(*) FILTER (WHERE l.method = 'parcel')::int AS loc_parcel,
             count(*) FILTER (WHERE l.method = 'census' AND l.quality = 'exact')::int AS loc_census_exact,
             count(*) FILTER (WHERE l.method = 'census' AND l.quality IS DISTINCT FROM 'exact')::int AS loc_census_other,
             count(*) FILTER (WHERE l.permit_id IS NULL)::int AS unlocated
        FROM permits p LEFT JOIN permit_locations l ON l.permit_id = p.id GROUP BY 1 ORDER BY 2 DESC`);
    table(['market', 'rows', 'parcel linked', 'point from source', 'from parcel', 'census exact', 'census other', 'not located'],
      link.map((r) => [r.source_area, r.n, pct(r.parcel, r.n), pct(r.loc_source, r.n), pct(r.loc_parcel, r.n), pct(r.loc_census_exact, r.n), pct(r.loc_census_other, r.n), pct(r.unlocated, r.n)]));
    const cols = ['land_use', 'year_built', 'heated_sqft', 'building_sqft', 'lot_sqft', 'bedrooms', 'bathrooms', 'units', 'floors', 'assessed_value', 'land_value', 'improvement_value', 'improvement_type', 'lat'];
    const have = new Set((await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'parcels'")).map((r) => r.column_name));
    const use = cols.filter((c) => have.has(c));
    const par = await q(`SELECT provider, count(*)::int AS n, count(*) FILTER (WHERE found)::int AS found,
                                min(fetched_at)::date::text AS first, max(fetched_at)::date::text AS last,
                                ${use.map((c, i) => `count(*) FILTER (WHERE found AND ${c} IS NOT NULL${['land_use', 'improvement_type'].includes(c) ? ` AND ${c} <> ''` : ` AND ${c}::text <> '0'`})::int AS c${i}`).join(', ')}
                           FROM parcels GROUP BY 1`);
    for (const r of par) {
      out(`**${r.provider}**: ${r.n} parcels asked, ${pct(r.found, r.n)} found, fetched ${r.first} to ${r.last}`);
      out();
      table(['attribute', 'share of found parcels'], use.map((c, i) => [c, pct(r[`c${i}`], r.found)]));
    }
    const lic = await q(`SELECT provider, count(*)::int AS n, count(*) FILTER (WHERE phone IS NOT NULL)::int AS phone,
                                count(*) FILTER (WHERE business_name IS NOT NULL AND business_name <> '')::int AS biz,
                                max(file_date)::date::text AS file_date, max(fetched_at)::date::text AS fetched
                           FROM registry_licences GROUP BY 1`);
    table(['licence registry', 'licences', 'with phone', 'with business name', 'provider file date', 'fetched'],
      lic.map((r) => [r.provider, r.n, pct(r.phone, r.n), pct(r.biz, r.n), r.file_date, r.fetched]));
  });

  await section('Cross-record links (application → permit, building → trade)', async () => {
    const links = await q(`
      SELECT f.source_area AS from_m, t.source_area AS to_m, pl.link_basis, count(*)::int AS n, round(avg(pl.confidence), 2) AS conf
        FROM permit_links pl JOIN permits f ON f.id = pl.from_permit_id JOIN permits t ON t.id = pl.to_permit_id
       GROUP BY 1, 2, 3 ORDER BY 4 DESC`);
    table(['from', 'to', 'basis', 'links', 'avg confidence'], links.map((r) => [r.from_m, r.to_m, r.link_basis, r.n, r.conf]));
    const apps = await q(`
      SELECT p.source_area, count(*)::int AS n,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM permit_links pl WHERE pl.from_permit_id = p.id))::int AS linked,
             count(*) FILTER (WHERE p.submitted_on < current_date - 180)::int AS old,
             count(*) FILTER (WHERE p.submitted_on < current_date - 180 AND EXISTS (SELECT 1 FROM permit_links pl WHERE pl.from_permit_id = p.id))::int AS old_linked
        FROM permits p WHERE p.filing_kind IS NOT NULL GROUP BY 1`);
    table(['market', 'applications', 'linked to a permit', 'submitted >180 d ago', 'of those linked'],
      apps.map((r) => [r.source_area, r.n, pct(r.linked, r.n), r.old, pct(r.old_linked, r.old)]));
    const jobs = await q(`
      SELECT p.source_area, count(DISTINCT pp.job_key) FILTER (WHERE pp.is_building)::int AS bjobs,
             count(DISTINCT pp.job_key) FILTER (WHERE pp.is_building AND EXISTS (
               SELECT 1 FROM permit_parties t WHERE t.job_key = pp.job_key AND t.trade IS NOT NULL AND t.permit_id <> pp.permit_id))::int AS with_trade
        FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id WHERE pp.job_key IS NOT NULL GROUP BY 1`);
    table(['market', 'building jobs', 'with a linked trade permit'], jobs.map((r) => [r.source_area, r.bjobs, pct(r.with_trade, r.bjobs)]));
  });

  await section('Duplicates', async () => {
    // Same market, same normalised address, same permit type and date, but a
    // different permit number: likely the same job listed twice.
    const within = await q(`
      WITH k AS (SELECT source_area, upper(regexp_replace(coalesce(address, ''), '[^A-Za-z0-9]', '', 'g')) AS a, permit_type, filed_date
                   FROM permits WHERE filing_kind IS NULL AND address IS NOT NULL AND filed_date IS NOT NULL)
      SELECT source_area, count(*)::int AS n, sum(c - 1)::int AS extra FROM (
        SELECT source_area, a, permit_type, filed_date, count(*) AS c FROM k GROUP BY 1, 2, 3, 4) g
       GROUP BY 1 ORDER BY 1`);
    const tot = Object.fromEntries(markets.map((m) => [m.source_area, m.n]));
    table(['market', 'address+type+date groups', 'rows beyond the first in a group', 'share of rows'],
      within.map((r) => [r.source_area, r.n, r.extra, pct(r.extra, tot[r.source_area])]));
    out('A group can legitimately hold several permits (units in one building), so this is an upper bound, not a defect count.');
    out();
    // City of Miami permits also issued by the county feed? Same address and date across the two sources.
    const cross = await q(`
      WITH m AS (SELECT upper(regexp_replace(address, '[^A-Za-z0-9]', '', 'g')) AS a, filed_date FROM permits WHERE source_area = 'miami-city-fl' AND address IS NOT NULL),
           d AS (SELECT DISTINCT upper(regexp_replace(address, '[^A-Za-z0-9]', '', 'g')) AS a, filed_date FROM permits WHERE source_area = 'miami-dade-fl' AND address IS NOT NULL)
      SELECT count(*)::int AS n, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM d WHERE d.a = m.a AND d.filed_date = m.filed_date))::int AS both FROM m`);
    out(`City of Miami rows with a county row at the same address and date: ${cross[0].both} of ${cross[0].n} (${pct(cross[0].both, cross[0].n)})`);
    out();
    const contractorDupes = await q(`
      SELECT business_state AS st, count(*)::int AS n FROM (
        SELECT business_state, normalized_name FROM contractors GROUP BY 1, 2 HAVING count(*) > 1) x GROUP BY 1`);
    table(['state', 'normalised names held by >1 contractor entity'], contractorDupes.map((r) => [r.st, r.n]));
  });

  await db.getPool().end();
}

main().catch(async (err) => {
  console.error(err);
  try { await db.getPool().end(); } catch { /* already closed */ }
  process.exit(1);
});
