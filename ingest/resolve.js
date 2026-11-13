// Rebuilds contractors, their contact points, permit parties and GC -> sub
// relationships from the latest raw record of every permit (ADR-12).
//
// A full deterministic rebuild in one transaction: running it twice gives the
// same result, and a failure leaves the previous state in place. Contractor ids
// are stable across runs (upsert on identity_key), so links to /contractors/:id
// keep working. Every run is recorded in resolver_runs.
//
//   node ingest/resolve.js

const db = require('../db/index.js');
const { EXTRACTORS, RESOLVER_VERSION, resolveParties, buildRelationships } = require('../src/contractors.js');

async function loadParties(client) {
  const slugs = Object.keys(EXTRACTORS);
  const { rows } = await client.query(`
    SELECT DISTINCT ON (r.source_id, r.source_key)
           r.id AS raw_record_id, r.source_key, r.payload, s.slug, s.id AS source_id
      FROM raw_records r JOIN sources s ON s.id = r.source_id
     WHERE s.slug = ANY($1::text[])
     ORDER BY r.source_id, r.source_key, r.fetched_at DESC, r.id DESC`, [slugs]);
  return rows.map((r) => ({
    ...EXTRACTORS[r.slug](r.payload),
    sourceSlug: r.slug, sourceId: r.source_id, rawRecordId: r.raw_record_id, sourceKey: r.source_key,
  }));
}

async function writeAll(client, { contractors, parties, relationships }) {
  const startedAt = (await client.query('SELECT now() AS t')).rows[0].t;

  // Contractors: upsert keeps ids stable.
  const { rows: ids } = await client.query(`
    INSERT INTO contractors (identity_key, display_name, normalized_name, party_kind, primary_trade, business_city,
                             business_state, first_permit_on, last_permit_on, permit_count, resolver_version, updated_at)
    SELECT *, $11, now() FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                                      $7::char(2)[], $8::date[], $9::date[], $10::int[])
    ON CONFLICT (identity_key) DO UPDATE SET
      display_name = EXCLUDED.display_name, normalized_name = EXCLUDED.normalized_name, party_kind = EXCLUDED.party_kind,
      primary_trade = EXCLUDED.primary_trade, business_city = EXCLUDED.business_city, business_state = EXCLUDED.business_state,
      first_permit_on = EXCLUDED.first_permit_on, last_permit_on = EXCLUDED.last_permit_on,
      permit_count = EXCLUDED.permit_count, resolver_version = EXCLUDED.resolver_version, updated_at = now()
    RETURNING id, identity_key`,
  [contractors.map((c) => c.identityKey), contractors.map((c) => c.displayName), contractors.map((c) => c.normalizedName),
    contractors.map((c) => c.partyKind), contractors.map((c) => c.primaryTrade), contractors.map((c) => c.businessCity),
    contractors.map((c) => c.businessState), contractors.map((c) => c.firstPermitOn), contractors.map((c) => c.lastPermitOn),
    contractors.map((c) => c.permitCount), RESOLVER_VERSION]);
  const idOf = new Map(ids.map((r) => [r.identity_key, r.id]));
  // A contractor no longer seen on any permit keeps its id but shows 0 permits.
  await client.query('UPDATE contractors SET permit_count = 0, updated_at = now() WHERE updated_at < $1', [startedAt]);

  // Derived tables are replaced wholesale.
  await client.query('DELETE FROM contractor_relationships');
  await client.query('DELETE FROM permit_parties');
  await client.query('DELETE FROM contact_points');
  await client.query('DELETE FROM contractor_licenses');
  await client.query('DELETE FROM contractor_aliases');

  const sourceIdOf = new Map(parties.map((p) => [p.sourceSlug, p.sourceId]));
  const aliases = contractors.flatMap((c) => c.aliases.map((a) => [idOf.get(c.identityKey), a.raw, sourceIdOf.get(a.source), a.n]));
  if (aliases.length) {
    await client.query(`INSERT INTO contractor_aliases (contractor_id, raw_name, source_id, seen_count)
      SELECT * FROM unnest($1::bigint[], $2::text[], $3::bigint[], $4::int[])`,
    [aliases.map((a) => a[0]), aliases.map((a) => a[1]), aliases.map((a) => a[2]), aliases.map((a) => a[3])]);
  }
  const lic = contractors.flatMap((c) => c.licences.map((l) => [idOf.get(c.identityKey), c.businessState, l]));
  if (lic.length) {
    await client.query(`INSERT INTO contractor_licenses (contractor_id, licence_state, licence_number, source)
      SELECT a, b, c, 'permit' FROM unnest($1::bigint[], $2::char(2)[], $3::text[]) AS t(a, b, c)
      ON CONFLICT DO NOTHING`, [lic.map((l) => l[0]), lic.map((l) => l[1]), lic.map((l) => l[2])]);
  }
  const cps = contractors.flatMap((c) => c.contacts.map((p) => ({ ...p, contractorId: idOf.get(c.identityKey) })));
  if (cps.length) {
    await client.query(`INSERT INTO contact_points (contractor_id, kind, value, party_kind, display_policy, source, source_ref,
                               verification, seen_on_permits, shared_with_other_contractors, last_seen_on)
      SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                           $8::text[], $9::int[], $10::int[], $11::date[])`,
    [cps.map((p) => p.contractorId), cps.map((p) => p.kind), cps.map((p) => p.value), cps.map((p) => p.partyKind),
      cps.map((p) => p.displayPolicy), cps.map((p) => p.source), cps.map((p) => p.sourceRef), cps.map((p) => p.verification),
      cps.map((p) => p.seenOnPermits), cps.map((p) => p.sharedWithOtherContractors), cps.map((p) => p.lastSeenOn)]);
  }
  // Parties join to the stored permit by (area, permit number); raw records
  // whose permit was never mapped (no key) are skipped.
  const { rowCount: partiesWritten } = await client.query(`
    INSERT INTO permit_parties (permit_id, role, contractor_id, raw_name, raw_trade, match_rule, match_confidence, raw_record_id,
                                job_key, is_building, trade, issued_on)
    SELECT p.id, 'contractor', t.contractor_id, t.raw_name, t.raw_trade, t.rule, t.conf, t.raw_id,
           t.job_key, t.is_building, t.trade, t.issued_on
      FROM unnest($1::text[], $2::text[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::bigint[],
                  $9::text[], $10::boolean[], $11::text[], $12::date[])
           AS t(area, permit_number, contractor_id, raw_name, raw_trade, rule, conf, raw_id, job_key, is_building, trade, issued_on)
      JOIN permits p ON p.source_area = t.area AND p.permit_number = t.permit_number
    ON CONFLICT (permit_id, role) DO NOTHING`,
  [parties.map((p) => p.sourceSlug), parties.map((p) => p.sourceKey), parties.map((p) => (p.identityKey ? idOf.get(p.identityKey) : null)),
    parties.map((p) => p.name), parties.map((p) => p.rawTrade), parties.map((p) => p.rule), parties.map((p) => p.confidence),
    parties.map((p) => p.rawRecordId), parties.map((p) => p.groupKey || null), parties.map((p) => Boolean(p.isBuilding)),
    parties.map((p) => p.trade || null), parties.map((p) => p.issuedOn || null)]);
  if (relationships.length) {
    await client.query(`INSERT INTO contractor_relationships (gc_id, sub_id, trade, jobs, first_job_on, last_job_on)
      SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::int[], $5::date[], $6::date[])`,
    [relationships.map((r) => idOf.get(r.gcKey)), relationships.map((r) => idOf.get(r.subKey)), relationships.map((r) => r.trade),
      relationships.map((r) => r.jobs), relationships.map((r) => r.first), relationships.map((r) => r.last)]);
  }
  return { partiesWritten };
}

function summarize(parties, contractors, relationships, partiesWritten) {
  const byRule = {};
  for (const p of parties) byRule[p.rule] = (byRule[p.rule] || 0) + 1;
  const byKind = {};
  for (const c of contractors) byKind[c.partyKind] = (byKind[c.partyKind] || 0) + 1;
  const phones = contractors.flatMap((c) => c.contacts);
  return {
    rawPermits: parties.length, partiesWritten, byRule, contractors: contractors.length, contractorsByKind: byKind,
    phones: phones.length, phonesShown: phones.filter((p) => p.displayPolicy === 'show').length,
    phonesCorroborated: phones.filter((p) => p.verification === 'corroborated').length,
    relationships: relationships.length,
  };
}

async function resolveAll() {
  const pool = db.getPool();
  const { rows: [run] } = await pool.query(
    "INSERT INTO resolver_runs (status, resolver_version) VALUES ('running', $1) RETURNING id", [RESOLVER_VERSION]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One resolver at a time; a second waits rather than interleaving deletes.
    await client.query('SELECT pg_advisory_xact_lock(727275)');
    const raw = await loadParties(client);
    const { contractors, parties } = resolveParties(raw);
    const relationships = buildRelationships(parties);
    const { partiesWritten } = await writeAll(client, { contractors, parties, relationships });
    await client.query('COMMIT');
    const stats = summarize(parties, contractors, relationships, partiesWritten);
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

async function main() {
  await db.applySchema();
  const stats = await resolveAll();
  // Keep the searchable (masked) descriptions current; see migration 010.
  stats.descriptionsMasked = await db.maskStoredDescriptions();
  console.log(JSON.stringify(stats, null, 2));
  await db.close();
}

if (require.main === module) {
  main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
}

module.exports = { resolveAll };
