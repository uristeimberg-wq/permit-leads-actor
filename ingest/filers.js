// Filers run (ADR-19): who filed each Austin building application, and
// whether that business is the builder or a permit expediter.
//
//   1. Read the two organisation fields from the latest raw record of every
//      plan-review case (src/filers.js filersOf). Owner and person-name
//      fields are not read.
//   2. For each organisation: the building permits its filings led to
//      (permit_links, masterpermitnum = folderrsn), how many of those the
//      same business pulled, and whether the same name is the contractor on
//      any Austin building permit we hold.
//   3. Classify (src/filers.js classify) and rebuild filing_filers and
//      filer_orgs wholesale in one transaction. Re-runs give the same result;
//      a failure leaves the previous state. Each run is a resolver_runs row.
//
// Runs after ingest/resolve.js and ingest/lifecycle.js (it reads their tables).
//
//   node ingest/filers.js

const db = require('../db/index.js');
const F = require('../src/filers.js');

const SOURCE = 'austin-plan-review-tx';
const BUILDING_SOURCE = 'austin-tx';

async function loadFilers(client) {
  const { rows } = await client.query(`
    SELECT DISTINCT ON (r.source_key) p.id AS permit_id, r.id AS raw_record_id,
           jsonb_build_object('applicant_organization_name', r.payload ->> 'applicant_organization_name',
                              'other_organization_name', r.payload ->> 'other_organization_name',
                              'owner_organization_name', r.payload ->> 'owner_organization_name') AS orgs
      FROM raw_records r
      JOIN sources s ON s.id = r.source_id AND s.slug = $1
      JOIN permits p ON p.source_area = s.slug AND p.permit_number = r.source_key
     ORDER BY r.source_key, r.fetched_at DESC, r.id DESC`, [SOURCE]);
  return rows.flatMap((r) => F.filersOf(r.orgs).map((f) => ({ ...f, permitId: r.permit_id, rawRecordId: r.raw_record_id })));
}

async function orgEvidence(client) {
  const { rows: linked } = await client.query(`
    SELECT ff.org_key,
           count(DISTINCT pp.permit_id)::int AS linked,
           count(DISTINCT pp.permit_id) FILTER (WHERE c.normalized_name = ff.org_key)::int AS self,
           count(DISTINCT pp.contractor_id) FILTER (WHERE c.normalized_name IS DISTINCT FROM ff.org_key)::int AS distinct_others
      FROM filing_filers ff
      JOIN permit_links k ON k.from_permit_id = ff.permit_id
      JOIN permit_parties pp ON pp.permit_id = k.to_permit_id AND pp.role = 'contractor' AND pp.is_building
      LEFT JOIN contractors c ON c.id = pp.contractor_id
     GROUP BY ff.org_key`);
  const { rows: known } = await client.query(`
    SELECT DISTINCT ON (c.normalized_name) c.normalized_name AS org_key, c.id, c.party_kind
      FROM contractors c
      JOIN permit_parties pp ON pp.contractor_id = c.id AND pp.role = 'contractor' AND pp.is_building
      JOIN permits p ON p.id = pp.permit_id AND p.source_area = $1
     WHERE c.normalized_name IN (SELECT org_key FROM filing_filers)
     GROUP BY c.normalized_name, c.id, c.party_kind
     ORDER BY c.normalized_name, count(*) DESC, c.id`, [BUILDING_SOURCE]);
  return { linked: new Map(linked.map((r) => [r.org_key, r])), known: new Map(known.map((r) => [r.org_key, r])) };
}

function buildOrgs(filers, { linked, known }) {
  const byKey = new Map();
  for (const f of filers) {
    const o = byKey.get(f.key) || { key: f.key, filings: new Set(), names: new Map() };
    o.filings.add(f.permitId);
    o.names.set(f.name, (o.names.get(f.name) || 0) + 1);
    byKey.set(f.key, o);
  }
  return [...byKey.values()].map((o) => {
    // Most frequent spelling; on a tie, one not in capitals, then the longer.
    const caps = (x) => (x === x.toUpperCase() ? 1 : 0);
    const displayName = [...o.names.entries()]
      .sort((a, b) => b[1] - a[1] || caps(a[0]) - caps(b[0]) || b[0].length - a[0].length || a[0].localeCompare(b[0]))[0][0];
    const l = linked.get(o.key) || { linked: 0, self: 0, distinct_others: 0 };
    const k = known.get(o.key) || null;
    const { role, basis } = F.classify({ name: displayName, linked: l.linked, self: l.self, distinct: l.distinct_others, knownBuilder: Boolean(k) });
    return {
      key: o.key, displayName, partyKind: F.filerKind(displayName, k && k.party_kind), role, basis,
      filings: o.filings.size, linked: l.linked, self: l.self, distinct: l.distinct_others, contractorId: k ? k.id : null,
    };
  });
}

async function runFilers() {
  const pool = db.getPool();
  const { rows: [run] } = await pool.query(
    "INSERT INTO resolver_runs (status, resolver_version) VALUES ('running', $1) RETURNING id", [F.CLASSIFIER_VERSION]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727276)');
    const filers = await loadFilers(client);
    await client.query('DELETE FROM filing_filers');
    await client.query('DELETE FROM filer_orgs');
    if (filers.length) {
      await client.query(`INSERT INTO filing_filers (permit_id, source_field, raw_name, org_key, raw_record_id)
        SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::bigint[]) ON CONFLICT DO NOTHING`,
      [filers.map((f) => f.permitId), filers.map((f) => f.field), filers.map((f) => f.raw), filers.map((f) => f.key), filers.map((f) => f.rawRecordId)]);
    }
    const orgs = buildOrgs(filers, await orgEvidence(client));
    if (orgs.length) {
      await client.query(`INSERT INTO filer_orgs (org_key, display_name, party_kind, role, basis, filings, linked_bps, self_bps,
                                                  distinct_contractors, contractor_id, classifier_version)
        SELECT *, $11 FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::int[],
                                  $9::int[], $10::bigint[])`,
      [orgs.map((o) => o.key), orgs.map((o) => o.displayName), orgs.map((o) => o.partyKind), orgs.map((o) => o.role),
        orgs.map((o) => o.basis), orgs.map((o) => o.filings), orgs.map((o) => o.linked), orgs.map((o) => o.self),
        orgs.map((o) => o.distinct), orgs.map((o) => o.contractorId), F.CLASSIFIER_VERSION]);
    }
    await client.query('COMMIT');
    const stats = summarize(filers, orgs);
    await pool.query("UPDATE resolver_runs SET status = 'succeeded', finished_at = now(), stats = $2 WHERE id = $1", [run.id, stats]);
    return stats;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await pool.query("UPDATE resolver_runs SET status = 'failed', finished_at = now(), error_detail = $2 WHERE id = $1",
      [run.id, String(err.stack || err.message).slice(0, 4000)]);
    throw err;
  } finally {
    client.release();
  }
}

function summarize(filers, orgs) {
  const count = (xs, k) => xs.reduce((m, x) => ({ ...m, [x[k]]: (m[x[k]] || 0) + 1 }), {});
  const byField = count(filers, 'field');
  const filingsWith = new Set(filers.map((f) => f.permitId)).size;
  const roleOf = new Map(orgs.map((o) => [o.key, o]));
  const filingsByRole = {};
  const perFiling = new Map();
  for (const f of filers) perFiling.set(f.permitId, [...(perFiling.get(f.permitId) || []), { ...f, ...roleOf.get(f.key) }]);
  for (const list of perFiling.values()) {
    const pick = F.pickFiler(list);
    const k = pick ? pick.role : 'withheld';
    filingsByRole[k] = (filingsByRole[k] || 0) + 1;
  }
  return {
    classifierVersion: F.CLASSIFIER_VERSION, filers: filers.length, filingsWithFiler: filingsWith, byField,
    orgs: orgs.length, orgsByRole: count(orgs, 'role'), orgsByKind: count(orgs, 'partyKind'), filingsByRole,
    orgsWithLinkedPermits: orgs.filter((o) => o.linked > 0).length,
  };
}

async function main() {
  await db.applySchema();
  const s = await runFilers();
  console.log([
    `Filers (${s.classifierVersion}): ${s.filers} organisations named on ${s.filingsWithFiler} Austin applications `
      + `(applicant field ${s.byField.applicant_organization_name || 0}, other-contact field ${s.byField.other_organization_name || 0}).`,
    `${s.orgs} organisations: ${Object.entries(s.orgsByRole).map(([k, n]) => `${k} ${n}`).join(', ')}; `
      + `${s.orgsWithLinkedPermits} have a linked building permit. Shown as business: ${s.orgsByKind.business || 0}.`,
    `Filer shown per application: ${Object.entries(s.filingsByRole).map(([k, n]) => `${k} ${n}`).join(', ')}.`,
  ].join('\n\n'));
  await db.close();
}

if (require.main === module) {
  main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
}

module.exports = { runFilers, buildOrgs };
