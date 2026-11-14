# Worker D: Cross-source intelligence and entity resolution (Austin pilot)

Date: 2026-11-14. Labels: **[Verified-live 2026-11-14]** = fetched by me
today (URL given); **[Read-from-page]** = a page or search-result title says
it, contents not tested; **[Unverified]** = memory or inference.
**Budget note:** the shared WebFetch budget (100/hour for all workers) ran out
after 17 of my calls. The Texas Comptroller, TBAE, TBPELS, SOS and Travis
County Clerk items below are therefore **not** live-verified; each says so.
They are the first things to re-check (list at the end).

Repo read: BRIEF, DATA_SOURCES pre-approval scan + enrichment sections,
ADR-2/12/14/15/16, DATA_MODEL lifecycle model, COMPLIANCE, `src/contractors.js`,
migrations 004, 005, 012-017.

---

## 0. Five findings that change the plan

1. **Austin's AMANDA system exposes three internal keys across its open
   datasets, and we use only one of them.** `folderrsn` (one id space for
   every folder: site plan `215185`, plan review `12797796`, BP `13791991`),
   `propertyrsn` (AMANDA's property id), and `peoplersn` / `owner_peoplersn`
   (AMANDA's people record) **[Verified-live 2026-11-14]**:
   - `n8ck-xkda` (plan review): `propertyrsn` on **2,840 of 2,840** cases
     applied since 2026-08-01, `appraisal_id` on 2,831 (99.7%).
     `https://datahub.austintexas.gov/resource/n8ck-xkda.json?$select=count(*),count(appraisal_id),count(propertyrsn)&$where=applied_date>'2026-08-01'`
   - `mavg-96ck` (site plan): `folderrsn`, `propertyrsn`, `tcad_id`,
     `permit_number` (`SP-99-0191C`), `applicant_organization_name`
     (e.g. Bury & Partners Inc., a civil engineering firm). No
     `related_cases` column in the rows read.
   - `edir-dcnf` (zoning): `folderrsn`, `case_number` (`C14-98-0224`),
     `related_cases` (`C14-2014-0189`), `propertyrsn`, `peoplersn`,
     `owner_peoplersn`, `organization_name`. **No `tcad_id` in the two rows
     read** (1990s cases); recent fill not measured (budget).
   - `3syk-w9eu` (issued): `project_id` (= the permit's own folderrsn, also in
     the `link` URL) and `masterpermitnum`, `tcad_id`. **No `propertyrsn`.**
   So the property join planning → application is an official city key
   (`propertyrsn`), not just the CAD parcel; the issued permit reaches it only
   through `masterpermitnum` → plan-review `folderrsn` or through `tcad_id`.
2. **`masterpermitnum` is a "parent folder" pointer, not always a plan-review
   case.** Verified today: `2025-024926 BP` → `13477167` = `2025-024917 PR`
   (Tarrytown Roofing LLC, same `appraisal_id` 0129040205) — good. But
   `13707738` is the parent of **33 BPs** (Circuit of the Americas event
   structures, one parcel) and is in neither `n8ck-xkda` nor `mavg-96ck`; and
   `2026-142757 MP` / `PP` point to `13797440`, which is not in `n8ck-xkda`
   **[Verified-live 2026-11-14]**. Note also the PR and BP numbers differ in
   base (`024917` vs `024926`), so the permit-number base used by ADR-12
   links BP to trades, never PR to BP. Consequence: an umbrella parent must
   not become "one project" automatically; the parent's kind has to be
   resolved by lookup, and the unresolved share measured (M1 check).
3. **`contractors-v1` already merges divisions and generic names across
   legal entities.** `normalizeName` strips `of`, `texas`, `tx` from the end:
   "Meritage Homes of Texas LLC" and "Meritage Homes Corporation" →
   `meritage homes`; "Pool Builders of Texas" and "Pool Builders Inc" →
   `pool builders`; "D.R. Horton - Texas, Ltd." → `dr horton` (run locally on
   the repo code today). For builder brands this is the grouping a customer
   wants; for two unrelated firms with a generic name it is a false merge
   that ADR-12 says must never happen. Fix: split **legal entity** from
   **brand cluster** (section 3) and stop treating geographic words as legal
   suffixes in the identity key.
4. **The owner's example chain's first hop ("purchase") cannot be shown under
   today's rules even when the buyer is a company.** Rule 5 and COMPLIANCE
   rule 1 say owner names are never displayed; TCAD use rules forbid loading
   deed fields. The deed is lawfully obtainable from the Travis County Clerk
   (paid copies / PIA; terms of its search site not read), but displaying a
   corporate buyer needs a new ADR that separates `owner_business` from
   `owner_individual`. Until then, purchase is storable evidence, not product.
5. **No graph database.** Every query the owner listed is 1-3 hops over
   tables of a few million rows; recursive CTEs and two rollup tables answer
   them. Apache AGE is not warranted (section 2.4).

---

## 1. Identifier inventory (Austin area)

| Identifier | Where | Authoritative? | Open? | Fill on our sources | Merge/link key? |
| --- | --- | --- | --- | --- | --- |
| `folderrsn` / `project_id` | All Austin AMANDA datasets | Yes (system id) | Yes, Public Domain | 100% (system field) | **Strong**: identity of one folder across datasets and re-syncs |
| `masterpermitnum` | `3syk-w9eu` | Yes | Yes | 97.6% of BPs since 2026-08-01 (scan, 2026-11-13) | **Strong** for "child of parent folder"; parent kind must be looked up (finding 2) |
| Permit-number base (`2026-142757`) | `3syk-w9eu` | Convention, not documented | Yes | 100% | **Strong** for BP ↔ trades (ADR-12); never PR ↔ BP |
| `propertyrsn` | `n8ck-xkda`, `mavg-96ck`, `edir-dcnf` | Yes (AMANDA property) | Yes | PR 100% (2,840/2,840) | **Strong for "same AMANDA property"**; not a project key (many projects per property over decades). Behaviour on replat unknown |
| `tcad_id` / `appraisal_id` | Issued, PR, site plan; = TCAD `geo_id` | TCAD's public id | Yes | PR 99.7%; issued 99.5%; 90.8-91.6% match TCAD (DATA_SOURCES) | **Strong for parcel at a date**; changes on replat (below) |
| TCAD `prop_id` | TCAD export | Yes (internal) | Yes (export) | 65 Austin letter-prefixed ids only match on `prop_id` | Strong within TCAD; use as the parcel row key, `geo_id` as alias |
| `condominium` flag | PR, issued | Yes | Yes | PR 32/2,840 = 1.1% "Yes" | Trap marker: condo units share land; do not parcel-window them |
| Zoning `case_number`, `related_cases` | `edir-dcnf` | Yes | Yes | `related_cases` present on old cases; recent fill not measured | **Strong** case ↔ case (exact case-number match) |
| Case number in Legistar titles | Legistar `austintexas` | Yes (city's own text) | Yes | Not parsed yet | **Strong** when an exact per-source regex matches (`C14-\d{4}-\d{4}`, `SP-\d{4}-\d{4}[A-Z]?`); else none |
| `peoplersn` / `owner_peoplersn` | `edir-dcnf` (seen); others not checked | Yes (AMANDA people row) | Yes | Not measured | **Medium**: same contact record, not the same legal entity; a person's row moves firms. Evidence for merges, never alone |
| Street address | All | City address string | Yes | ~100% | **Weak**: ranges ("1000-1010"), unit numbers, renamed streets. Candidate only (ADR-16 `address_window`) |
| City address points (`addresses-8ff5a` on catalog.data.gov) | City GIS | Yes | Read-from-page (catalog title only) | n/a | Could normalise addresses to a point id; **not checked** (budget) |
| Texas Comptroller taxpayer number (11 digits) | *(Corrected 2026-11-14: `9cir-efmm` is a City of Austin datahub id, last modified 2026-01-24; the Comptroller's public API is the source, see ../2026-11-14-data-engine/sources-and-contractors.md.)* "Active Franchise Tax Permit Holders", data.texas.gov `9cir-efmm` (dataset id from search results and a third-party mirror) | Yes (state) | Open dataset **[Read-from-page]**; columns **[Unverified]**: taxpayer number, name, mailing address, organisation type, SOS file number, SOS charter/status dates | Austin permits carry no taxpayer number: 0% | **Strong for a legal entity**, but reaching it from a permit name is a name match. Use: verify + attach legal name and SOS number, never merge two of our rows on it unless both reached it by exact legal name |
| Comptroller Public Information Report (officers, directors, registered agent) | Comptroller franchise "account status" search | Yes | Web search page; automation terms unread | 0% | Individuals' names: store at most, never display; registered agent address is a **trap** (thousands of entities) |
| Texas SOS file number | SOSDirect (paid per search, account) **[Unverified fee]**; SOS bulk data orders page `sos.state.tx.us/corp/sosda` **[Read-from-page title]** | Yes | Paid | 0% | Strong legal-entity key; obtain free via the Comptroller file's SOS field if that column is confirmed |
| Assumed names (DBA) | Entities: SOS (Form 503); sole props: county clerk | Yes | SOS paid; county search | 0% | DBA → legal entity is **strong** only from the filing itself |
| TDLR licence (`7358-krk7`) | data.texas.gov | Yes | Yes (attribution required) | Austin permits carry **no** licence number; name match 85% EP / 74% MP companies (DATA_SOURCES) | Strong only where a source publishes the number; for Austin it is verification by name/phone (ADR-15) |
| TSBPE plumbing licence | tsbpe.texas.gov CSV | Yes | Yes | None on permits; company-name match 76% | Same as TDLR; rows are persons |
| TBAE architect registration / firm registration | `indreg.tbae.texas.gov/Reports/RegistrantRosters`, `bizreg.tbae.texas.gov/Home/BusinessRosters` **[Read-from-page: titles in search results]** | Yes | Rosters appear to be offered; format, fields and terms **not read** | Austin datasets name no architect (no field in PR/issued/site plan rows read) | Strong for an architecture firm **once a document names it** (worker B's plan sheets/TABS). Firm roster = business; individual roster = persons (rule 5) |
| TBPELS engineering firm registration (F-number) | `pels.texas.gov/roster/firmsearch.html`, `eng_rosters.html`, `downloads.htm` **[Read-from-page titles]** | Yes | Roster pages exist; downloadable list **not confirmed** | Site-plan applicants are mostly civil firms (Bury & Partners) | Strong for an engineering firm; join by exact legal name, then F-number |
| TABC licence/permit number | `mxm5-tdpj` (pending) | Yes | Yes | Pending rows have trade name + owner, number issued later | Strong TABC-to-TABC; to a project only by address (weak → candidate) |
| TDLR TABS project number | TABS per-project pages (no dataset) | Yes | Public pages, terms decision pending (scan #4) | n/a | Strong TABS ↔ TABS; to a permit by address + owner (candidate); names design firm |
| Phones | Permits | No | Yes | 91% | **Never a key** (49 Austin phones under 2+ names; ADR-12) |

**Parcel changes (replat/subdivision).** TCAD issues new `geo_id`s for new
lots after a plat records, usually effective with a later roll; the parent
account is retired **[Unverified: TCAD export has no documented "previous
id" column in what DATA_SOURCES recorded]**. Austin subdivision cases
(`s7gx-9m54`, not fetched today) and the plan-review `legal_description`
("LOT 13 BLK C BLUFFINGTON SEC 2") are the lawful evidence of lineage. So:
a zoning or preliminary-plan case filed on the parent tract and a PR filed on
a child lot two years later **share no parcel id**. Link them through
`propertyrsn` only if AMANDA keeps it (unknown), else through
`parcel_lineage` (2.2) built from subdivision cases + geometry containment
(child lot point inside the parent polygon) → **inferred, never auto**.

---

## 2. Knowledge graph in Postgres

### 2.1 Principle: typed tables are the nodes, typed link tables are the edges, one view is the graph

Nodes already exist or are designed: `permits` (filings, incl. PR cases),
`planning_cases`, `agenda_items`, `contractors` (= businesses, view
`businesses`), `parcels`, `projects`, worker B's `documents` /
`document_extractions`, `lifecycle_events`. Edges already exist:
`permit_parties`, `permit_links`, `permit_parcels`, `project_members`,
`contractor_relationships` / `business_relationships`,
`contractor_registry_licences`, `business_identifiers`.

**Extend them with one common provenance block** rather than adding a
generic triple store:

```sql
-- Applied to permit_parties, permit_links, permit_parcels, project_members,
-- contractor_registry_licences, business_identifiers (new migration, additive)
ALTER TABLE permit_links
  ADD COLUMN status         TEXT NOT NULL DEFAULT 'confirmed'
             CHECK (status IN ('confirmed','inferred','candidate','rejected')),
  ADD COLUMN evidence_raw_record_id BIGINT REFERENCES raw_records(id) ON DELETE SET NULL,
  ADD COLUMN evidence_extraction_id BIGINT,            -- document_extractions(id), worker B
  ADD COLUMN observed_on    DATE,                      -- the date the evidence speaks for (source date)
  ADD COLUMN asserted_by    TEXT NOT NULL DEFAULT 'linker-v1', -- resolver/linker version or 'review:<user>'
  ADD COLUMN asserted_at    TIMESTAMPTZ NOT NULL DEFAULT now();
-- status = 'confirmed' only for official keys or human review; 'inferred'
-- for rule-based parcel/time links; 'candidate' waits for review; 'rejected'
-- is kept so the linker never proposes it again (rule 2: idempotent).
```

New edge kinds that have no typed table go in **one** generic table:

```sql
CREATE TABLE entity_links (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_kind     TEXT NOT NULL CHECK (from_kind IN ('project','parcel','business','person','planning_case','permit','document','agenda_item','event')),
  from_id       BIGINT NOT NULL,
  to_kind       TEXT NOT NULL CHECK (to_kind IN ('project','parcel','business','person','planning_case','permit','document','agenda_item','event')),
  to_id         BIGINT NOT NULL,
  edge_type     TEXT NOT NULL,   -- 'case_related_to','agenda_cites_case','parcel_parent_of','document_names',
                                 -- 'business_dba_of','business_division_of','business_brand_member',
                                 -- 'acts_as_agent_for','person_employed_by' (hidden), ...
  link_basis    TEXT NOT NULL,   -- 'official_reference','same_record','registry_record','exact_name_registry',
                                 -- 'parcel_window','geometry_contains','address_window','document_text','review'
  basis_detail  TEXT NOT NULL,   -- 'related_cases contains C14-2014-0189'
  confidence    NUMERIC(3,2) NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('confirmed','inferred','candidate','rejected')),
  evidence_raw_record_id BIGINT REFERENCES raw_records(id) ON DELETE SET NULL,
  evidence_extraction_id BIGINT,
  observed_on   DATE,            -- date of the evidence
  valid_from    DATE,            -- only when the source states it (licence issue, SOS status date)
  valid_to      DATE,            -- only when the source states it; NULL = not stated, NOT "still true"
  asserted_by   TEXT NOT NULL,
  asserted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_kind, from_id, to_kind, to_id, edge_type, link_basis)
);
CREATE INDEX entity_links_to   ON entity_links (to_kind, to_id, edge_type);
CREATE INDEX entity_links_from ON entity_links (from_kind, from_id, edge_type);
-- Polymorphic ids are not FK-enforced; a nightly integrity check (rule 3)
-- counts dangling ids per kind and records them in source_events.

CREATE VIEW graph_edges AS                      -- read side only
  SELECT 'permit' fk, pl.from_permit_id f, 'permit' tk, pl.to_permit_id t, 'leads_to' et,
         pl.link_basis, pl.confidence, pl.status, pl.observed_on, pl.asserted_by FROM permit_links pl
  UNION ALL
  SELECT 'project', pm.project_id, pm.member_kind, pm.member_id, 'has_member',
         pm.link_basis, pm.confidence, pm.status, pm.observed_on, pm.grouper_version FROM project_members pm
  UNION ALL
  SELECT 'business', pp.contractor_id, 'permit', pp.permit_id, 'party:'||pp.role,
         pp.match_rule, pp.match_confidence, pp.status, pp.observed_on, pp.asserted_by
    FROM permit_parties pp WHERE pp.contractor_id IS NOT NULL
  UNION ALL
  SELECT from_kind, from_id, to_kind, to_id, edge_type, link_basis, confidence, status, observed_on, asserted_by
    FROM entity_links;
```

### 2.2 Node additions

```sql
-- Persons: stored for linking and expediter detection, never displayed or exported (rule 5).
CREATE TABLE persons (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id     BIGINT NOT NULL REFERENCES sources(id),
  source_person_key TEXT NOT NULL,   -- 'peoplersn:3113', or 'namephone:<sha256>' when no id
  name_hash     TEXT NOT NULL,       -- sha256 of normalized name; raw name stays in raw_records only
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_person_key)
);
-- No cross-source person merge in v1: a person is one source's record.
-- privacy.test.js gains a guard that no API selects from persons.

-- Planning-case and filing parties beyond contractors (DATA_MODEL roles), plus the AMANDA keys.
ALTER TABLE permit_parties ADD COLUMN source_people_key TEXT;   -- 'peoplersn:3113'
ALTER TABLE permit_parties ADD COLUMN person_id BIGINT REFERENCES persons(id);
-- planning_case_parties mirrors this.

-- AMANDA property and parcel lineage.
ALTER TABLE permits        ADD COLUMN source_property_key TEXT;  -- 'propertyrsn:138334'
ALTER TABLE planning_cases ADD COLUMN source_property_key TEXT;
CREATE INDEX ON permits (source_property_key);
CREATE INDEX ON planning_cases (source_property_key);

CREATE TABLE parcel_lineage (
  parent_parcel_id BIGINT NOT NULL REFERENCES parcels(id),
  child_parcel_id  BIGINT NOT NULL REFERENCES parcels(id),
  basis            TEXT NOT NULL CHECK (basis IN ('provider_previous_id','subdivision_case','geometry_contains')),
  evidence_ref     TEXT NOT NULL,        -- case number or roll year
  effective_year   INTEGER,
  status           TEXT NOT NULL CHECK (status IN ('confirmed','inferred','rejected')),
  PRIMARY KEY (parent_parcel_id, child_parcel_id, basis)
);

-- Legal entity vs brand (finding 3).
ALTER TABLE contractors ADD COLUMN entity_level TEXT NOT NULL DEFAULT 'name_cluster'
  CHECK (entity_level IN ('legal_entity','name_cluster','brand'));
-- legal_entity: identity proven by a registry key (taxpayer no., SOS no., licence)
-- name_cluster: today's contractors-v1 rows
-- brand: a grouping row (Meritage Homes) whose members are linked by
--        entity_links 'business_brand_member' with evidence.

-- business_identifiers (DATA_MODEL) gains provenance and a strength:
ALTER TABLE business_identifiers
  ADD COLUMN strength TEXT NOT NULL DEFAULT 'strong' CHECK (strength IN ('strong','evidence')),
  ADD COLUMN raw_record_id BIGINT REFERENCES raw_records(id) ON DELETE SET NULL,
  ADD COLUMN valid_to DATE;                         -- licence expiry / SOS forfeiture, as published
-- id_kind adds: 'tx_taxpayer','tx_sos','tbae_firm','tbpels_firm','tabc','austin_peoplersn'(evidence)
-- UNIQUE (id_kind, id_value) holds only for strength='strong' (make it a partial unique index).

-- Review queue for merges and links (the "reviewed merge" ADR-12 promises).
CREATE TABLE link_reviews (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject      TEXT NOT NULL CHECK (subject IN ('business_merge','project_link','parcel_lineage','brand_member')),
  left_ref     TEXT NOT NULL, right_ref TEXT NOT NULL,
  proposed_by  TEXT NOT NULL,             -- rule id + version
  features     JSONB NOT NULL,            -- what matched, what didn't
  decision     TEXT CHECK (decision IN ('accept','reject','defer')),
  decided_by   TEXT, decided_at TIMESTAMPTZ,
  UNIQUE (subject, left_ref, right_ref)
);
```

`business_relationships` (DATA_MODEL) stays the derived co-occurrence rollup;
add `relationship_kind` ('worked_with' only, for now) and `evidence_count_confirmed`
(projects linked only by confirmed edges) so the UI can say "12 projects, 9
on official links".

### 2.3 Time semantics (owner's "historical ≠ current")

- `observed_on` = the date the evidence is about (application date, issue
  date, agenda date). `asserted_at` = when we wrote it. `valid_to` is filled
  **only** when a source states an end (licence expiry, SOS forfeiture,
  permit final). NULL `valid_to` means "no end stated", never "current".
- A relationship row has `first_on` / `last_on`. The UI wording is fixed:
  "Worked together on N projects, most recently <month year>". It never says
  "works with". "Currently on this project" exists only for a confirmed
  `permit_parties` row on a member of this project (ADR-16 item 6).
- Resolver re-runs rewrite derived rows under a new `asserted_by` version;
  `rejected` review decisions are keyed by refs, not row ids, so they survive.

### 2.4 Graph DB or Apache AGE?

Not warranted. Data: ~1-3M filings, ~50-100k businesses, edges in low
millions. Queries: fixed shapes of 1-3 hops (business → permits → project →
other businesses). Postgres handles these with joins and, for lineage or
case chains, `WITH RECURSIVE` bounded at depth 5. AGE would add a second
query language, its own upgrade path, and **Neon does not list AGE among its
supported extensions [Unverified]**; that alone blocks it on our host
(ADR-2). Revisit only if a measured variable-length path query (e.g. "within
3 degrees of this architect") exceeds 1 s p95 after indexing, or the edge
table passes ~50M rows.

---

## 3. Merge and link rules

Tiers: **A** = auto-confirm; **B** = inferred, auto-written as `inferred` and
labelled "possible link" (ADR-16 label 4), never used for "confirmed" counts;
**C** = candidate, written to `link_reviews` only; **X** = never.

### 3.1 Filings → projects

| Hop | Rule | Tier | Note |
| --- | --- | --- | --- |
| PR case → BP | BP `masterpermitnum` = PR `folderrsn`, and same `tcad_id` | A (0.95) | Verified 4+1 samples; rate unmeasured |
| BP → trade permits | same permit-number base, or same `masterpermitnum` | A (0.95) | ADR-12 |
| Parent folder with >5 BPs (COTA: 33) | `masterpermitnum` shared by many BPs | A as **"program"**, not one project | Create a parent project with child projects per BP; otherwise one GC "did 33 projects" |
| `masterpermitnum` resolving to no known folder | — | B | Keep as `official_reference` to an unknown parent; count it (rule 3) |
| Zoning case ↔ zoning case | `related_cases` exact case number | A | |
| Agenda item → planning case | exact per-source regex on title | A | No fuzzy case numbers |
| Site plan → PR / BP | same `propertyrsn` or `tcad_id`, PR applied after site plan, within 36 months, and site plan "new construction"/units | B (0.6) | Becomes A only if a document or the city cites the SP number on the PR (worker B) |
| Zoning → site plan | same `propertyrsn` within 48 months | B (0.5) | Zoning often precedes sale; buyer may differ |
| Parent tract case → child-lot PR | `parcel_lineage` (subdivision case or geometry) | C | Replat trap |
| Same address string, no parcel | — | C | Address ranges, units |
| Condo (`condominium = Yes`) or multi-unit parcel | parcel window | X for auto | Many projects per parcel |
| TABC pending app → permit | normalised address + trade name in description | C | |
| TABS project → permit | address + owner business exact | C | |

### 3.2 Businesses

| Situation | Rule | Tier |
| --- | --- | --- |
| Same licence number in a published-number source (Miami-Dade, TDLR file) | licence | A (0.95) |
| Same TX taxpayer or SOS number, each reached by **exact legal name** from the registry file | registry_record | A (0.9) → `legal_entity` |
| Exact normalised name, same state (today's v1) | name_state | A (0.8) as `name_cluster`, **after** removing `of texas` / `texas` from the suffix list for multi-word generic names (finding 3) |
| Name differs only by "of Texas"/"- Texas"/division words ("Meritage Homes of Texas LLC", "Meritage Homes Corporation") | brand rule | B: `business_brand_member` to a brand row; never merged into one legal entity |
| Near-miss spelling ("& AC" vs "and Air Conditioning") | — | C (ADR-12) |
| DBA → legal entity | assumed-name filing (SOS/county) or TDLR row listing both | A with the filing; otherwise C |
| Same phone, different names | — | X as a merge; evidence only (49 shared phones) |
| Same `peoplersn` across two org names | — | C (a person changed firms, or an expediter) |
| Same registered agent or registered-agent address | — | **X** (one agent serves thousands of entities) |
| Same mailing address | — | X alone; evidence for C only if suite numbers match and no agent |
| Parent/subsidiary | stated in a filing (SOS, SEC 10-K subsidiary list for public builders) | A with the document; else X |
| Expediters as applicants | an applicant org on PRs for ≥ N distinct owner/builder orgs and parcels in 90 days, or a name lexicon ("permit", "expediting", "permitting") | Classify role `expediter` (B), reviewable; exclude from "worked with" counts and from "the applicant is the builder" logic |

### 3.3 People (stored, never displayed)

| Rule | Tier |
| --- | --- |
| Same `peoplersn` within Austin AMANDA | A (same source record) |
| Same normalised name + same E.164 phone within one source | B |
| Any cross-source person merge (permit ↔ TDLR ↔ Comptroller officer) | X in v1: no product need, high privacy cost |
| Person → business employment | B from the same filing (applicant person + applicant org); used only to detect expediters and firm moves; never shown |

### 3.4 Known traps (checklist for tests)

Expediters as applicants (Austin Permit Service etc.); shared office phones;
registered agents' addresses; replats changing `tcad_id`; condo parcels
(1.1% of PRs); multi-parcel projects (a site plan listing several `tcad_id`s
— store all, link each, project keeps one id); address ranges and unit
suffixes; umbrella `masterpermitnum` (COTA 33 BPs); owner-builders; builder
divisions vs parents; ETJ/other-city jurisdictions in site plans (`MANOR FULL
PURPOSE`, `SB 2038 ETJ RELEASE` seen today) whose BPs are not in Austin's
permit data at all.

---

## 4. The owner's example chain, mapped to Austin

purchase → zoning → site plan by architect → commission → permit application → contractor

| # | Hop | Austin source | Key | Strength | Lawful / displayable |
| --- | --- | --- | --- | --- | --- |
| 1 | Land purchase | Travis County Clerk Official Public Records (deed; online "Recording Search + Copies of Records" page exists **[Read-from-page title]**; bulk via vendors such as TaxNetUSA **[Read-from-page title]**) | Legal description / grantee name → parcel | **Inferred** (legal description to `geo_id` is fuzzy; deeds carry no geo_id reliably) | Obtainable lawfully (purchase, PIA); automated reading of the clerk site's terms **not read**. TCAD deed fields barred by our rules. **Not displayable** under rule 5 even for an LLC buyer (finding 4) |
| 2 | Zoning case | `edir-dcnf` | `propertyrsn` (+ `tcad_id` where filled) | Property link strong; "same project as the purchase" inferred | Open, public domain. Owner org stored, not shown |
| 3 | Site plan "by architect" | `mavg-96ck` | `propertyrsn`/`tcad_id` to zoning: **inferred (B)** | Applicant org is usually the **civil engineer** (Bury & Partners), not an architect; the dataset has no architect field | Architect appears only in documents (worker B) or TDLR TABS (design firm) → then TBAE firm roster confirms the firm (strong once named) |
| 4 | Commission | Legistar `austintexas` | exact case number in title | **Strong** (when pattern matches) | Open API |
| 5 | Permit application | `n8ck-xkda` | `propertyrsn`/`tcad_id` to site plan: **inferred**; same applicant org is supporting evidence | B | Open |
| 6 | Building permit | `3syk-w9eu` | `masterpermitnum` = PR `folderrsn` | **Strong** | Open |
| 7 | Contractor (GC, then subs) | `3syk-w9eu` | number base / `masterpermitnum` | **Strong** | Open; person-like names withheld |

Net: hops 4, 6, 7 are strong; 2→3→5 are inferred property-and-time links
(strong property, inferred project); hop 1 is lawful to obtain but not
displayable, and the architect in hop 3 needs documents.

---

## 5. Query set (SQL shapes)

All counts default to **confirmed** edges; inferred ones are reported in a
separate column. All read from `business_relationships` /
`permit_parties` / `project_members` with `observed_on`.

**Q1. Companies repeatedly involved in similar projects.** "Similar" =
same `filing_kind`/permit class family + units band + area.

```sql
SELECT b.id, b.display_name, pp.role, count(DISTINCT pm.project_id) AS projects,
       count(DISTINCT pm.project_id) FILTER (WHERE pm.status='confirmed') AS confirmed_projects,
       max(p.submitted_on) AS last_seen
FROM permit_parties pp
JOIN permits p          ON p.id = pp.permit_id
JOIN project_members pm ON pm.member_kind='permit' AND pm.member_id=p.id
JOIN businesses b       ON b.id = pp.contractor_id
WHERE p.permit_class = ANY($classes) AND p.source_area = $area
  AND p.submitted_on >= now() - interval '24 months'
  AND pp.role <> 'expediter'
GROUP BY 1,2,3 HAVING count(DISTINCT pm.project_id) >= 3
ORDER BY projects DESC;
```

**Q2. Architects who submitted multiple applications recently.** Requires an
architect party (documents/TABS); until then the answer is "applicants",
labelled as such.

```sql
SELECT b.display_name, count(*) AS applications, min(p.submitted_on), max(p.submitted_on)
FROM permit_parties pp JOIN permits p ON p.id=pp.permit_id JOIN businesses b ON b.id=pp.contractor_id
WHERE pp.role='architect' AND p.submitted_on >= current_date - 90
GROUP BY 1 HAVING count(*) >= 2 ORDER BY 2 DESC;
```

**Q3. Early planning, no building permit yet.**

```sql
SELECT pr.id, pr.current_stage, pr.first_seen_at
FROM projects pr
WHERE EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=pr.id
                AND m.member_kind IN ('planning_case','agenda_item'))
  AND NOT EXISTS (SELECT 1 FROM project_members m JOIN permits p ON p.id=m.member_id
                  WHERE m.project_id=pr.id AND m.member_kind='permit' AND p.lifecycle_stage IN ('issued','inspections','completed'))
-- plus parcels with an open planning case and no PR/BP on the same propertyrsn:
UNION
SELECT NULL, 'pre_application', min(pc.first_seen_at) FROM planning_cases pc
WHERE pc.lifecycle_stage='pre_application'
  AND NOT EXISTS (SELECT 1 FROM permits p WHERE p.source_property_key = pc.source_property_key
                    AND p.submitted_on >= pc.filed_on)
GROUP BY pc.source_property_key;
```
Caveat shown with it: "no permit found" can mean "not in Austin's
jurisdiction" (ETJ cases) or a replat changed the parcel.

**Q4. Contractors with rising activity.**

```sql
WITH m AS (
  SELECT pp.contractor_id, date_trunc('month', p.submitted_on) mon, count(DISTINCT pp.job_key) jobs
  FROM permit_parties pp JOIN permits p ON p.id=pp.permit_id
  WHERE pp.is_building AND p.submitted_on >= current_date - interval '12 months'
  GROUP BY 1,2)
SELECT contractor_id,
       sum(jobs) FILTER (WHERE mon >= current_date - interval '3 months') AS last3,
       sum(jobs) FILTER (WHERE mon <  current_date - interval '3 months') / 3.0 AS prior_avg3
FROM m GROUP BY 1
HAVING sum(jobs) FILTER (WHERE mon >= current_date - interval '3 months') >= 5
ORDER BY last3 / NULLIF(prior_avg3,0) DESC NULLS LAST;
```
Uses `submitted_on`, not issue date (issue date measures city speed, not
contractor activity). Submitted dates must exist; where only issue date is
published, say so.

**Q5. Historical relationships relevant to a new project.**

```sql
-- confirmed participants of project $p
WITH cp AS (SELECT DISTINCT pp.contractor_id, pp.role FROM project_members m
            JOIN permit_parties pp ON m.member_kind='permit' AND pp.permit_id=m.member_id
            WHERE m.project_id=$p AND m.status='confirmed' AND pp.role<>'expediter')
SELECT cp.contractor_id AS known, br.to_id AS associated, br.to_role, br.shared_projects,
       br.evidence_count_confirmed, br.first_on, br.last_on
FROM cp JOIN business_relationships br ON br.from_id=cp.contractor_id AND br.from_role=cp.role
WHERE br.last_on >= current_date - interval '36 months'
ORDER BY br.evidence_count_confirmed DESC, br.last_on DESC LIMIT 20;
```
Output label is ADR-16's "Historically associated: worked with X on N
earlier projects, most recently <date>", never "the GC on this project".

---

## Top recommendations for the Austin pilot

1. **Store `propertyrsn`, `project_id`, `peoplersn` now** (normalize step;
   additive columns). They are free, official and 100% filled where present.
2. **Measure the masterpermitnum resolution rate** at scale (share of BP
   `masterpermitnum` found as an `n8ck-xkda` `folderrsn`; share that are
   umbrellas with >5 children) before promising application → permit
   tracking. Add the "program" parent rule.
3. **Fix the generic-name merge** in `contractors-v1` (`of texas` stripping)
   and add `entity_level` (legal entity / name cluster / brand) before
   business_relationships widens to new roles.
4. **Add the provenance block + `entity_links` + `link_reviews`** (one
   migration); keep typed tables as the write path; `graph_edges` view.
5. **Expediter role classifier** on plan-review applicants, so "who works with
   whom" is not polluted by permit services.
6. **Comptroller franchise file (`9cir-efmm`) as legal-entity verification**
   for builders/GCs, after verifying its columns and size (statewide file is
   large: load only matched rows, as migration 013 does for licences).

## Valuable-looking but not worth it now

- **Graph DB / Apache AGE**: no measured need; host likely lacks it.
- **Deed purchases (Travis Clerk)**: lawful to buy, but nothing from it can be
  shown under rule 5, and legal-description matching is fuzzy.
- **Comptroller officers / PIR, SOS officer data**: individuals' names; no
  displayable value; data-broker exposure (COMPLIANCE 4.1).
- **Cross-source person resolution**: privacy cost, no product use.
- **SOSDirect per-search lookups**: paid per query and needs an account; the
  Comptroller file may carry the SOS number free (to verify).
- **TBAE/TBPELS rosters before documents name architects/engineers**: Austin
  datasets carry no architect field, so there is nothing to join to yet.

## Not verified (re-check when the fetch budget allows)

`9cir-efmm` columns and row count; TBAE roster formats/terms; TBPELS
downloadable firm list; SOS bulk-order price and SOSDirect fee; Travis County
Clerk search terms and bulk pricing; Austin address-point dataset id/fields;
`edir-dcnf` recent `tcad_id`/`related_cases`/`peoplersn` fill; subdivision
`s7gx-9m54` fields; whether `propertyrsn` survives replats; Neon's AGE support.
