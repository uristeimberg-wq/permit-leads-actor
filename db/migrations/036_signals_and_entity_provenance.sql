-- 036: one model over the construction signals, and a provenance class on
-- every entity link (data-engine brief, phases 2 and 3;
-- docs/research/2026-11-15-engine-gap-analysis.md). Views only: nothing is
-- copied, so nothing can drift from the tables it reads. No screen reads
-- these yet.
--
-- Provenance classes (the brief's words for the trust classes of ADR-26):
--   verified_source        A: a value the source itself records
--   cross_source_verified  B: a join on an official key (permit or master
--                          number, licence number, the source's parcel id)
--   parsed_inferred        C: a name, phone, parcel-window or address join,
--                          or a rule applied to text
--   missing                nothing recorded or nothing linked
--
-- No `projects` table: one parcel carries many projects over the years, so
-- grouping by parcel would invent projects. Filings connect only through the
-- explicit links in signal_links, each with its basis and class.

CREATE FUNCTION link_provenance(basis TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN basis IS NULL THEN 'missing'
    WHEN basis IN ('same_record', 'official_reference', 'official', 'licence') THEN 'cross_source_verified'
    ELSE 'parsed_inferred' END
$$;

-- 1. Every signal, pre-permit to inspection, in one shape. parcel_ref is the
-- parcel id as the filing publishes it (verified_source), or else the key of
-- the parcel linked on the source's own parcel id (cross_source_verified;
-- Miami-Dade's folio lives in the raw row, not a permit column). parcel_id is
-- our parcels row.
CREATE VIEW construction_signals AS
SELECT 'permit:' || p.id AS signal_id,
       CASE WHEN p.filing_kind = 'building_application' THEN 'building_application' ELSE 'permit' END AS signal_type,
       'permit'::text AS record_type, p.id AS record_id,
       p.source_area, p.permit_number AS source_record_id,
       p.status_raw AS raw_status, p.lifecycle_stage, lifecycle_phase(p.lifecycle_stage) AS lifecycle_phase,
       coalesce(p.submitted_on, p.filed_date) AS filed_on, p.stage_since,
       p.address AS address_raw, coalesce(p.parcel_number, pp.parcel_key) AS parcel_ref, pp.parcel_id,
       CASE WHEN p.parcel_number IS NOT NULL THEN 'verified_source'
            WHEN pp.parcel_key IS NOT NULL THEN 'cross_source_verified' ELSE 'missing' END AS parcel_ref_provenance,
       CASE WHEN pp.parcel_id IS NULL THEN 'missing' ELSE 'cross_source_verified' END AS parcel_id_provenance,
       p.first_seen_at, p.first_seen_stage
  FROM permits p
  LEFT JOIN LATERAL (SELECT x.parcel_id, pa.parcel_key FROM permit_parcels x JOIN parcels pa ON pa.id = x.parcel_id
                      WHERE x.permit_id = p.id ORDER BY x.provider LIMIT 1) pp ON true
UNION ALL
SELECT 'planning_case:' || c.id, c.case_kind, 'planning_case', c.id,
       c.source_area, c.case_number,
       c.status_raw, c.lifecycle_stage, lifecycle_phase(c.lifecycle_stage),
       c.filed_on, c.stage_since,
       c.address_raw, c.parcel_id, NULL::bigint,
       CASE WHEN c.parcel_id IS NULL THEN 'missing' ELSE 'verified_source' END, 'missing',
       c.first_seen_at, c.first_seen_stage
  FROM planning_cases c
UNION ALL
SELECT 'inspection:' || i.id, 'inspection', 'inspection', i.id,
       i.source_area, i.inspection_key,
       i.result_raw, 'inspections', 'inspection',
       i.scheduled_on, i.scheduled_on,
       i.address_raw, NULL, NULL::bigint, 'missing', 'missing',
       i.first_seen_at, NULL
  FROM inspections i;

-- 2. How signals connect: application -> permit, planning case -> permit,
-- inspection -> permit. Each link keeps its basis, its confidence and its
-- class; a parcel-window link is an inference however often it is right.
CREATE VIEW signal_links AS
SELECT 'permit:' || l.from_permit_id AS from_signal, 'permit:' || l.to_permit_id AS to_signal,
       l.link_basis, l.basis_detail, l.confidence, link_provenance(l.link_basis) AS provenance, l.linked_at
  FROM permit_links l
UNION ALL
SELECT 'planning_case:' || l.case_id, 'permit:' || l.permit_id,
       l.link_basis, l.basis_detail, l.confidence, link_provenance(l.link_basis), l.linked_at
  FROM planning_case_links l
UNION ALL
SELECT 'inspection:' || i.id, 'permit:' || i.permit_id,
       'official_reference', 'inspection permit_number = permit_number', 1.00, 'cross_source_verified', i.updated_at
  FROM inspections i WHERE i.permit_id IS NOT NULL;

-- 3. Entity links with their class. permit_parties.match_rule: a licence
-- number on the permit is an official key; a name-and-state or one-Sunbiz-
-- entity join is an inference; owner_builder is a rule on text; unresolved
-- links nothing.
CREATE VIEW entity_links AS
SELECT 'permit_contractor'::text AS link_type, 'permit'::text AS from_type, pp.permit_id AS from_id,
       'contractor'::text AS to_type, pp.contractor_id AS to_id,
       pp.match_rule, pp.match_confidence,
       CASE pp.match_rule WHEN 'licence' THEN 'cross_source_verified'
                          WHEN 'unresolved' THEN 'missing'
                          ELSE 'parsed_inferred' END AS provenance,
       pp.raw_record_id
  FROM permit_parties pp
UNION ALL
SELECT 'contractor_licence', 'contractor', crl.contractor_id, 'registry_licence', crl.licence_id,
       crl.match_rule, crl.match_confidence, link_provenance(crl.match_rule), NULL::bigint
  FROM contractor_registry_licences crl
UNION ALL
SELECT 'contractor_registration', 'contractor', cr.contractor_id, 'business_registration', cr.registration_id,
       cr.match_rule, cr.match_confidence, 'parsed_inferred', NULL::bigint
  FROM contractor_registrations cr
UNION ALL
SELECT 'permit_parcel', 'permit', x.permit_id, 'parcel', x.parcel_id,
       x.match_rule, NULL::numeric, 'cross_source_verified', NULL::bigint
  FROM permit_parcels x;

-- 4. Portfolios from linked source records only, split by the class of the
-- link, so a name-only link is never counted as verified.
CREATE VIEW contractor_portfolio AS
SELECT c.id AS contractor_id, c.identity_key, c.party_kind,
       count(*) FILTER (WHERE pp.match_rule = 'licence')::int AS permits_licence_linked,
       count(*) FILTER (WHERE pp.match_rule IN ('name_state', 'legal_entity'))::int AS permits_name_linked,
       count(DISTINCT p.source_area)::int AS markets,
       min(pp.issued_on) FILTER (WHERE pp.match_rule = 'licence') AS first_licence_linked_on,
       max(pp.issued_on) FILTER (WHERE pp.match_rule = 'licence') AS last_licence_linked_on,
       min(pp.issued_on) AS first_linked_on, max(pp.issued_on) AS last_linked_on,
       count(*) FILTER (WHERE p.lifecycle_stage IN ('submitted', 'in_review', 'corrections', 'approved'))::int AS filings_before_issue,
       count(*) FILTER (WHERE p.lifecycle_stage = 'completed')::int AS permits_completed
  FROM contractors c
  JOIN permit_parties pp ON pp.contractor_id = c.id
  JOIN permits p ON p.id = pp.permit_id
 GROUP BY c.id, c.identity_key, c.party_kind;

-- 5. The lifecycle CHECKs from 035 were NOT VALID until the live rows were
-- counted: recon/engine_verify.js found 0 permits and 0 planning cases
-- outside the vocabulary (2026-11-15, before 035). Validating now makes the
-- constraint hold for every row, not only new writes.
ALTER TABLE permits VALIDATE CONSTRAINT permits_lifecycle_stage_check;
ALTER TABLE planning_cases VALIDATE CONSTRAINT planning_cases_lifecycle_stage_check;
