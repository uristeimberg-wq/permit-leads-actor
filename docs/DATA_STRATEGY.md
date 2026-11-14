# Data strategy: early signals, linking and proprietary history

- **Date:** 2026-11-14. **Status:** accepted 2026-11-14 (ADR-18). Build order in
  section 10; new connectors still wait for the pilot results.
- **Scope:** the owner's "Proprietary Data Discovery and Hidden Opportunity
  Intelligence" brief (2026-11-14), researched by five parallel workers and
  consolidated here. Pilot market: **Austin**.
- **Evidence:** the worker reports are in
  [`docs/research/2026-11-14-early-signals/`](research/2026-11-14-early-signals/)
  (A sources, B documents, C indirect signals, D entity resolution, E
  competitors and acquisition). Labels used there and here:
  **[V]** fetched live on the date given; **[RfP]** a page states it, not
  tested; **[U]** unverified belief. All five workers shared a 100-fetch-per-hour
  budget that ran out, so county, state and competitor items are thinner than
  the City of Austin items. That gap is listed in section 11.
- **Builds on:** ADR-16 and `docs/DATA_SOURCES.md` "Pre-approval scan"
  (2026-11-13), `docs/DATA_MODEL.md` "Lifecycle model", ARCHITECTURE section 19.

## 1. The answer in one page

**There is no hidden dataset that gives us a monopoly in Austin.** Every
early record we found is either already public and structured (and therefore
copyable by any competitor within weeks), or lawful but slow and paid (county
clerk records, public-information requests). The advantage has to come from
four things competitors are not doing for our slice, in this order:

1. **Official links nobody else uses.** Austin's permit system (AMANDA) puts
   internal keys in its open datasets: `folderrsn` (one id space for every
   folder), `propertyrsn` (its own property id, on 100% of plan-review cases
   since August), and `masterpermitnum` [V, Worker D]. Building-permit
   descriptions cite site-plan numbers ("Concurrent Review: SP-2023-0202C")
   [V, Worker C]. These turn "same parcel, similar time" guesses into
   official links from planning case to application to permit to trade
   permits.
2. **History that cannot be backfilled.** Austin's planning datasets publish
   the *current* status only; there is no record of when a case stalled,
   was postponed or changed applicant [V, Worker C]. A competitor who starts
   in a year cannot recover what we snapshot from today. First-seen times,
   status histories, verified links and outcomes are the only genuinely
   proprietary inputs, and they cost almost nothing to start collecting.
3. **Precision on who is behind a filing.** The plan-review applicant is often
   a permit expediter; the site-plan applicant is a civil engineer; builders
   file under several legal entities. Resolving these correctly (and not
   merging unrelated firms) is the difference between "who works with whom"
   and noise.
4. **A narrow, measurable product claim**: *the residential and
   light-commercial building applications filed in Austin this week, the
   builder behind each, which subs that builder used by trade, and which
   trades are not permitted yet* (Worker E). No competitor page read claims
   it; Zabalist could add the same feed in a week, so execution speed and
   precision are the moat, not access.

**Where the owner's brief is wrong or premature** (details in section 9):

- A fully automated source-discovery engine is premature. Discovery is cheap
  and already exists (`recon/preapproval_scan.js`); evaluation (terms,
  field maps, join keys, quality) is the bottleneck and must stay human by our
  own hard rules.
- A general AI document pipeline is not worth building for Austin now. The
  structured datasets already carry most of a packet, Legistar's PDF host
  forbids automated download, and meeting-packet AI is a crowded category.
- A graph database is not needed. Postgres with typed edge tables answers
  every query the owner listed in one to three hops.
- The "purchase" step in the owner's example chain cannot be shown under
  today's rules, even when the buyer is a company.
- The roadmap's early-capture gate (80%) will pass automatically and prove
  little; it needs a second number (section 7.1).
- Planning-stage signals in Austin are strongest for multifamily and
  commercial, where Dodge and ConstructConnect are strongest. For
  single-family infill, the realistic early window is the plan-review period
  (median 63 days before issue), not months earlier.

**Recommended initial strategy:** keep the core (plan review, issued and
trade permits) and add **three** structured Austin sources (site plans,
subdivisions, affordable-housing pipeline) plus one derived signal
(demolition to new build), all public domain. Prove with a **backtest** and a
**4-week forward test** that the combination surfaces projects an issued-permit
search misses, and by how much time, before adding anything else (section 8).

## 2. What the five workers found

| Worker | Most important finding | Changes the plan because |
| --- | --- | --- |
| A, sources | Three new open Austin datasets: Affordable Housing Inventory `ifzc-3xz8` (developer named on every sampled row; 13 "Loan Awarded", 181 "Certified"), Roadway Work Zones `qyfh-gwei` (ROW permits with `folderrsn` and future dates; open, unlike the token-gated AMANDA ROW layer), ROW Contractor Licences `8d92-wsiw` (licence number as a firm key) [V]. Most other city datasets are dead ends (demolition datasets are views of the issued feed; water meter data stale; no historic-review dataset) [V]. Texas has an optional Affidavit of Commencement (Prop. Code 53.124) [U] | Adds one genuinely early source with a named developer; the rest of the "unconventional" list is either already ingested, stale, or bid data that competitors own |
| B, documents | Legistar's `austintexas` API holds **only Council and its committees**; the land-use boards publish on `austintexas.gov/boards-commissions` with PDFs on `services.austintexas.gov/edims` [V]. `austintexas.legistar1.com/robots.txt` is `Disallow: /` [V]. On a sampled zoning case, the dataset already had parcel, owner org, agent firm, request and status; the packet adds proposed use, votes, postponements and opposition [V]. Volume is ~80-100 case items a month; LLM extraction would cost a few dollars a month | Corrects `DATA_SOURCES.md` (Legistar is not the planning-commission source). Document intelligence is cheap but its marginal value is narrow; a deterministic agenda index is enough |
| C, indirect signals | Join keys: `tcad_id` on 99.4% of BPs and plan-review cases, 94% of site plans, 93% of zoning, 84% of subdivisions; zoning `related_cases` 0% filled [V]. Samples (not rates): site plans 6 of 11 reached a main BP, median ~10 months lead; approved 2022 rezonings 0 of 6 reached a BP in ~4.8 years; residential demolitions 7 of 9 converted but median only 88 days, often after the new-home application [V]. Replats change parcel ids, so parcel joins under-count residential conversion | Ranks site plans first, rezonings last, and shows the early-capture metric is mis-specified. Provides the L1-L4 evidence ladder and a backtest that needs no Neon storage |
| D, entity resolution | AMANDA keys `folderrsn`, `propertyrsn`, `peoplersn` are in the open data and we store one [V]. `masterpermitnum` is a parent pointer, not always a plan-review case (one parent has 33 BPs) [V]. **The current resolver merges different legal entities**: `normalizeName` maps "Meritage Homes of Texas LLC" and "Meritage Homes Corporation" to `meritage homes`, and "Pool Builders of Texas" and "Pool Builders Inc" to `pool builders` (re-run on the repo code 2026-11-14) | A correctness bug against ADR-12 that must be fixed before relationships widen to new roles. Postgres design for the knowledge graph with one provenance block on every edge |
| E, competitors | **Zabalist** (Texas, "deepest in Austin") already sells Austin issued permits, site plans, TCAD values, TDLR TABS, deeds and contractor work history, from $49/month [RfP]. No plan-review intake or GC-sub analytics seen on its pages (absence untested). ConstructConnect planning tier $199/month per market [RfP]; Shovels $599-999/month and now sells zoning "Decisions" [RfP]. GatherGov already sells an Austin pipeline from 1,015 meetings and 1,606 documents [RfP]. Austin public-information fees and portal read [RfP] | Site plans, TCAD and TDLR are commodities in Austin; agenda AI is crowded. Narrows the defensible slice to plan-review intake + official links + GC-sub history + trade gap. Requires a side-by-side test before any claim to customers |

## 3. Source map: earliest stage each source reveals (Austin)

Ladder: land, entitlement, site plan / design, building application, issued
permit, construction activity, completion.

| Stage | Sources (status) | Lead over BP **issue** | Business named at this stage | Who already sells it |
| --- | --- | --- | --- | --- |
| Land | Travis County Clerk deeds, plats, construction deeds of trust (counsel; price unknown); TCEQ pending wastewater permits and MUD creation (probe) | Years | Grantee, lender (not displayable today) | Zabalist (deeds), title-data vendors |
| Entitlement | Zoning `edir-dcnf` (live API); subdivision `s7gx-9m54`; Affordable Housing `ifzc-3xz8`; boards-commissions agendas; Williamson County court agendas (counsel) | 6 months to years | Agent firm (often a land-use lawyer), developer (affordable housing) | Shovels "Decisions", GatherGov, Zabalist (partly) |
| Site plan / design | Site plan `mavg-96ck`; TDLR TABS (counsel) | ~6-23 months | Civil engineer (applicant), owner org | Zabalist, ConstructConnect, Dodge (commercial) |
| Building application | **Plan review `n8ck-xkda` (live in our pipeline)** | Median 63 days (residential), p90 300 | Applicant org (builder or expediter) | **No competitor page claims it** |
| Issued permit | Issued permits `3syk-w9eu` (live); demolition subset | 0 | Contractor company 91%, phone | Everyone |
| Construction activity | Roadway Work Zones `qyfh-gwei`; trade permits; TABC pending applications | Negative | Contractor on large jobs only | Partly |
| Completion | Certificates of occupancy, green building ratings | Negative | History value | Partly |

## 4. Evidence ladder: does a project exist?

From Worker C, section 3. This answers *whether there is a project*; the four
participant labels in `DATA_MODEL.md` answer *who is involved*. They are
shown in separate places and never combined into one badge.

| Level | Entry rule | Example | Allowed wording | Never |
| --- | --- | --- | --- | --- |
| **L1 Confirmed application** | A government record of an application or permit to build here, members joined only by `same_record` or `official_reference` | Plan-review case; issued BP and its trade permits | "Building application filed <date> (City of Austin <case>)" | "Approved" before the source says so |
| **L2 Documented early-stage project** | An official planning case whose own record proposes a building on an identified parcel, status not terminal | Site plan with a building land use; final plat; (TABS if approved) | "Site plan in review: <proposed use>. No building application yet. Typical time to an application in Austin: <measured median>" | "Coming soon", a start date, an inferred GC |
| **L3 Potential construction signal** | An official record that does not itself propose a building, in a category whose **measured** base rate clears a floor (proposed: P(new BP within 24 months) at least 15% and at least 3x the parcel base rate) | Rezoning, demolition, variance, site-plan extension | "Possible future project: <signal>. In Austin 2019-24, <x>% of similar cases were followed by a building application within 24 months (n=<n>)" | Shown without its base rate and n |
| **L4 Unverified hypothesis** | Anything else: score-only combinations, address or name-only matches, land transfers | Our inference | Admin view only | Alerts, exports, automatic promotion |

Promotion happens only on new official evidence that itself qualifies. A
terminal status (expired, withdrawn, denied) demotes immediately, the project
keeps its id, and the screen says "Ended: <status> <date>". A `parcel_window`
link between an L2 site plan and an L1 application stays "possible link" until
a description cites the case number or the source publishes the reference.

## 5. Source registry

### 5.1 What it records

The owner's list of registry fields maps to columns on the existing `sources`
table (migration later, after approval) or to a side table. The **seed** for
28 sources is committed as JSON in
[`docs/research/source_registry.json`](research/source_registry.json), so it
can be reviewed in a PR before any schema exists.

```sql
-- Written as a numbered migration when item 10 of section 10 is reached.
CREATE TABLE source_registry (
  id                 TEXT PRIMARY KEY,           -- 'austin-site-plan-tx'; equals sources.key when integrated
  name               TEXT NOT NULL,
  jurisdiction       TEXT NOT NULL,
  category           TEXT NOT NULL,              -- planning_case | building_application | issued_permit | land_record | ...
  url                TEXT NOT NULL,
  earliest_stage     TEXT NOT NULL CHECK (earliest_stage IN ('land','entitlement','site_plan',
                       'building_application','issued_permit','construction_activity','completion','none')),
  access             TEXT NOT NULL,              -- open_api | html_and_pdf | portal_search | paid_bulk | records_request | blocked_robots
  terms              TEXT NOT NULL,              -- as read, with the page
  legal_gate         TEXT NOT NULL CHECK (legal_gate IN ('open','counsel','blocked')),
  cadence            TEXT NOT NULL,              -- measured where possible (ARCHITECTURE 19.2)
  measured_lag_p50_h NUMERIC,                    -- filled by the E0 snapshot, never guessed
  history_from       TEXT,
  participants       TEXT,                       -- which roles are named, with fill rates
  join_keys          TEXT[] NOT NULL DEFAULT '{}',
  integration_status TEXT NOT NULL CHECK (integration_status IN ('live','candidate','probe','deferred','on_hold','excluded')),
  verified           TEXT NOT NULL,              -- live | page | search_result
  verified_on        DATE NOT NULL,
  basis              TEXT NOT NULL CHECK (basis IN ('measured','estimated')),
  scores             JSONB NOT NULL,             -- the nine criteria below, 1-5
  marginal_preapp_capture NUMERIC,               -- from the backtest: share of BPs this source sees first (section 7)
  integration_cost   TEXT,                       -- S | M | L with the reason
  notes              TEXT,
  reviewed_by        TEXT NOT NULL,
  reviewed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 5.2 Scoring framework

Nine criteria from the owner's brief, scored 1-5. **Legal feasibility is a
gate, not a weight**: a high score must never buy its way past a legal problem.

| Criterion | Weight | 5 means | 1 means |
| --- | --- | --- | --- |
| Early discovery | 20 | Land or entitlement stage | Issued or later |
| Uniqueness | 15 | No competitor known to have it for our slice (verified) | Every platform has it |
| Actionability | 15 | A user knows whom to call and why this week | Nothing to do with it |
| Contact intelligence | 10 | Business named with a reachable contact | No participants |
| Freshness | 10 | Same-day publication | Stale or one-off |
| Coverage | 10 | Many relevant projects a month in the pilot | A handful a year |
| Reliability | 10 | Stable official API with history | Fragile HTML, changes often |
| Cost (5 = cheap) | 10 | Free, small build | Paid feed or large build |
| Legal feasibility | gate | `open`: may be scheduled. `counsel`: listed, not built. `blocked`: excluded | |

`score = sum(weight x (criterion - 1) / 4)`, 0-100. Then the next action is
decided by rules, in order: live sources are listed apart; blocked or excluded
sources are skipped; `counsel` sources wait for a written decision; on-hold and
deferred stay so; firm registries are `reference` (judged by link value, not
lead value); below 45 skip; estimated scores mean **verify** first; 55 and up
with measured scores is **pilot**; the rest is backlog.

**The rubric is a prior.** Once the backtest runs, `uniqueness` and
`coverage` for planning sources are replaced by the measured
`marginal_preapp_capture`: the share of new-construction BPs that this source
saw first, after the sources already live. That is the honest version of
"prioritise differentiation over record counts": a source that adds a million
rows but no earlier sightings scores zero there.

`node recon/source_registry.js` validates the seed and prints the ranking
(tested offline in `recon/source_registry.test.js`). Current output:

| Action | Score | Source | Earliest stage | Gate |
| --- | --- | --- | --- | --- |
| pilot | 66 | Austin Site Plan Cases | site_plan | open |
| pilot | 65 | Austin Subdivision Cases | entitlement | open |
| pilot | 60 | Austin Affordable Housing Inventory | entitlement | open |
| pilot | 55 | Demolition to new build (derived) | issued_permit | open |
| pilot | 55 | Austin Roadway Work Zones | construction_activity | open |
| verify | 60 | TCEQ pending water-quality permits | land | open |
| verify | 58 | City of Austin public-information request | land | open |
| backlog | 54 | Austin Zoning Cases (backtest only) | entitlement | open |
| backlog | 48 | Austin boards and commissions agendas | entitlement | open |
| reference | 46 / 34 | ROW contractor licences; Comptroller franchise file | none | open |
| counsel | 66 | Travis County Clerk records | land | counsel |
| counsel | 60 | Miami-Dade Notices of Commencement (on hold) | construction_activity | counsel |
| counsel | 45-51 | WilCo court agendas, Austin Energy, Georgetown GIS, TABC, TDLR TABS, TCEQ NOIs | various | counsel |
| skip | | Philadelphia, Legistar PDFs (robots), procurement, capital budget, water meters, Legistar API (duplicates zoning) | | |

## 6. Knowledge graph and entity resolution

Design in Worker D, sections 2-5; summary here.

**Shape.** No graph database (ADR-2 holds; Neon does not offer Apache AGE
[U], and every listed query is 1-3 hops). Typed tables are the nodes
(`projects`, `parcels`, `contractors` as businesses, people stored but never
displayed, `planning_cases`, `permits`, `documents`, `lifecycle_events`).
Typed link tables are the edges (`project_members`, `permit_parties`,
`planning_case_parties`, `business_identifiers`, `business_relationships`),
plus one generic `entity_links` table for cross-type links and a
`link_reviews` queue. A `graph_edges` view unions them for analysis.

**Every edge carries the same provenance block:** `link_basis`, `confidence`,
`status` (confirmed / inferred / rejected), `evidence` (raw record or document
extraction ids), `observed_on`, `valid_from` / `valid_to` when the source
states them, and `asserted_by` (resolver version). No end date stated never
means "current": a historical relationship is shown with its last date.

**Merge and link tiers.**

| Tier | Projects | Businesses | Action |
| --- | --- | --- | --- |
| Strong | Same record; `masterpermitnum` to a plan-review `folderrsn`; a case number cited in a description (exact pattern); permit-number base for trades | Licence number in a state; ROW licence; Comptroller taxpayer or SOS file number | Automatic |
| Medium | Same `propertyrsn` or `tcad_id` within a window; plat name matched to `legal_description` | Exact normalized legal name in a state | Candidate; shown as "possible link" or merged only on review |
| Weak | Address or geometry proximity alone | Similar names, shared phone, shared address, registered agent | Never merged |

**Fixes required before relationships widen to architects, engineers,
developers and expediters:**

1. **Resolver bug.** `contractors-v1` strips geographic words such as "of
   Texas" as if they were legal suffixes, so unrelated firms with generic
   names merge (confirmed on the repo code 2026-11-14). Split three levels:
   legal entity (merge key), name cluster (display grouping), brand
   (Meritage Homes across its entities, a reviewed grouping).
2. **Store the free official keys**: `propertyrsn`, `project_id` and
   `peoplersn` in the normalize step (additive columns).
3. **Umbrella parents.** Measure how often a BP's `masterpermitnum` resolves to
   a plan-review case; a parent with many children (event structures,
   campuses) becomes a "program", not one project.
4. **Expediter role.** An applicant org seen on many unrelated builders'
   applications is classified `expediter` and excluded from "worked with"
   counts.

**The owner's example chain, in Austin:**

| Hop | Source | Link to the previous hop | Strength |
| --- | --- | --- | --- |
| Company buys property | Travis County Clerk deed | Legal description or grantee to parcel | Inferred, and **not displayable** today (section 9.4) |
| Zoning application | `edir-dcnf` | `propertyrsn` / `tcad_id` + time | Inferred (medium) |
| Architect submits site plan | `mavg-96ck` (applicant is usually the **civil engineer**; no Austin dataset has an architect field) | `propertyrsn` / `tcad_id` + time | Inferred (medium); architect only from documents or TABS |
| Planning commission discusses it | Boards-commissions agenda | Exact case number | Strong |
| Building application | `n8ck-xkda` | Case number cited in the description, else parcel + time | Strong when cited |
| Contractor associated | `3syk-w9eu` and trade permits | `masterpermitnum`, permit-number base | Strong |

The SQL for the owner's five questions (repeat collaborators, architects with
recent applications, early activity without a BP, contractors with rising
activity, relevant historical relationships) is in Worker D, section 5.

## 7. Measuring the advantage

### 7.1 Two capture numbers, not one

Every Austin BP has a plan-review case with the same application date, so
"share of BPs seen before issue" will be near 100% and only measures lead over
**issuance** (Worker C). The thesis "we find projects before a permit search
would" needs a second number:

- **Application capture** = share of new BPs we saw at plan review before
  issue, and the lead (today's E gate, keep at 80%).
- **Pre-application capture** = share of new-construction BPs that had an
  earlier L2 or L3 signal, the lead over the **application** date, by segment
  (single-family, multifamily, commercial) and by link basis.

Expect pre-application capture to be **low for single-family infill** (no site
plan; the demolition is close in time) and higher for multifamily and
commercial [inference from samples].

### 7.2 Speed

ARCHITECTURE section 19.2-19.4 already defines cadence tiers, the 14-day
metadata snapshot (E0) and latency metrics. This strategy adds three rules:

1. **Discovery latency** per source = our `first_seen_at` minus the source's
   own timestamp for that event (status date, application date). Socrata
   `:created_at` is a bulk reload in Austin and is never used.
2. **Daily status snapshots of planning cases start now**, because the source
   keeps no history (section 1, point 2). They are small (~9k Austin cases).
3. A verified L1 or L2 signal is searchable before enrichment (ADR-16 rule 5
   unchanged).

### 7.3 Competitive check

Before any customer claim: take 50 recent Austin plan-review folders and 25
site plans, and record whether Zabalist (free or $49), Shovels (free) and
ConstructConnect (trial, if available) show each one, on what date, with
which company, and linked to which permits (Worker E). This costs at most
$49 and a day.

## 8. Pilot: prove combined signals surface what permit searches miss

**Question.** Over a fixed Austin window, how many projects does the combined
set (plan review + site plans + subdivisions + affordable housing + demolition
signal, linked by official keys) surface **before** they are findable by an
issued-permit search, how much earlier, with which business named, and how
many of those does a competitor already show?

**P0 Backtest (read-only, no Neon storage).** A new `feasibility` workflow
input runs Worker C's design (section 4) in an Actions job with a throwaway
`postgres:17` service: ~270k rows (~55 MB) from `mavg-96ck`, `edir-dcnf`,
`s7gx-9m54`, `n8ck-xkda`, `3syk-w9eu` and `ifzc-3xz8`, 2019-2024, about 25
polite paged requests. Output is an aggregate report (a few KB). It computes,
per signal and combination: P(main BP applied within 6/12/24 months) with
confidence intervals and n, lift over a matched parcel control, a -5-year
date-shift placebo, Kaplan-Meier lead times, both capture numbers, and the hit
rate of case-number citations in BP descriptions. Outcomes are main buildings
only (pools, carports and dumpsters count as "New" and would inflate
conversion). Every SoQL filter is checked to have changed the result, because
some tooling silently ignores filters (Worker C).

**P1 Competitive check** (section 7.3), in parallel.

**P2 Forward test, 4 weeks, combined with ROADMAP E8.** Load only Austin
planning cases (site plans, subdivisions, affordable housing; a few MB) and
snapshot them daily. Each weekday produce the list of projects at L1 (no
issued BP) or L2, with the business behind each and its history, for 3-5
Austin GCs, builders or suppliers (owner's choice in ADR-16).

**Pass criteria (proposed; the owner may change the numbers):**

| # | Check | Pass |
| --- | --- | --- |
| 1 | Pre-application capture, multifamily + commercial new BPs (backtest) | At least 30%, median lead at least 120 days over the application |
| 2 | L2 site plans with a building use that reach a main BP within 24 months (backtest) | At least 50% |
| 3 | Projects a week in the forward list at L1/L2 with a named, resolved business (not an expediter) | At least 25 |
| 4 | Of the P1 sample, share not shown by any checked competitor on the same date with the same company | At least 60% |
| 5 | Design partners (E8) say "new and early enough" | 3 of 5, at least once a week |

If 1 and 2 fail but 3-5 pass, the edge is the plan-review window plus
relationships, and the planning feeds are dropped. If 4 fails, the product is
the GC-sub analytics and trade-gap lists, not early discovery.

**P0 result (2026-11-14, run 43575063372; full tables in
`docs/research/2026-11-14-early-signals/P0-backtest-results.md`).**
Criterion 1 **passes**: 91.9% of new multifamily (5+) and 80.3% of new
commercial buildings had a planning record on file first, median 363 and 385
days before the building application. Criterion 2 **fails**: 22.0% of
building site plans are followed by a new main building within 24 months.
Single-family, 84% of new main BPs, has an earlier planning record for only
7.3%; demolitions precede 19.3% of new homes, by weeks. The city property id
(`propertyrsn`) links 99.9% of new main BPs to plan review, so planning links
are official for most projects.

**P1 result (2026-11-14, partial; `docs/research/2026-11-14-early-signals/P1-competitor-check.md`).**
Criterion 4 is **undetermined but leaning pass**: 4 of 50 sampled plan-review
cases could be checked before the fetch budget ran out, and Zabalist showed
none of them ("Permit Not Found"), nor a two-week-old approved case; its
issued-permit page for the resulting BP had no applied date, company or trade
links. Zabalist shows 10 of 10 new site plans within 2 days, with a business
named on 9. Shovels' public docs show an `in_review` status but a twice-monthly
refresh plus up to a week to the API, so it cannot be same-day. ConstructConnect
and BuildZoom were not checked.

**Focus (owner, 2026-11-14):** homes first, apartments and commercial as
context (ADR-18). P2's daily list leads with residential plan-review filings,
the resolved builder (expediters flagged) and its sub history.

**Storage.** P0 uses none. P2 adds a few MB. Neither needs the Neon upgrade,
but the database is already past the 80% alarm (813 MB of 1 GB on
2026-11-13), so the upgrade is still required for normal daily growth.

## 9. Where the brief should change (blunt)

### 9.1 Automated source discovery engine: build the minimum, not the engine

Discovery is already automated: `recon/preapproval_scan.js` swept 337
Socrata and 366 ArcGIS candidates on 2026-11-13. Austin's Socrata domain has
680 datasets; the ten newest since 2026-10-02 contained nothing useful for
construction, and five of them had a blank or "see terms" licence [V,
Worker E]. Agenda systems (Legistar, eScribe, CivicPlus, Destiny) have no
searchable catalog, so each suburb is a hand-built adapter. Reading terms,
mapping fields and finding join keys cannot be automated reliably, and hard
rules 1, 4 and 10 require a human to verify a field map and terms before a
source runs.

**Minimum version (effort S, after M1):** a weekly catalog-diff mode in
`preapproval_scan.js` for the pilot domains, a schema-drift alarm on sources
we already ingest (partly exists in `ingest/drift.js`), new candidates written
to the registry as `probe` with estimated scores, and `recon/source_registry.js`
ranking them for a human. Revisit a fuller engine when we enter a fifth
market.

### 9.2 Document intelligence: a deterministic agenda index, later

Build only after the backtest shows that agenda-only fields (proposed use,
postponement, opposition, HLC demolition applications) matter: a daily index
of the boards-commissions meeting pages (~4 requests), exact-pattern case
numbers, document labels (which already say "postponement request",
"opposition letters"), hashes for change detection, and a 60-item
hand-checked set. No OCR (every sample was born-digital), no LLM extraction
until the hand-checked set shows a gap, no Legistar PDFs (robots), no packet
backfill. Design and schema in Worker B, section 4.

### 9.3 The data that is "hard to find" is mostly hard to find for a reason

The genuinely unique Texas items are lawful but slow or paid: county clerk
records (deeds, construction deeds of trust, optional Affidavits of
Commencement, mechanic's liens), Austin Water service-extension logs (records
request only), TCEQ construction NOIs (records request), TDLR TABS (portal).
They are worth one request each to learn price and format, not engineering
now.

### 9.4 The purchase hop needs a decision, not a connector

Rule 5 and `COMPLIANCE.md` rule 1 hide owner names, and the Travis CAD rules
bar deed fields. Showing a company that bought land would need a new ADR that
separates `owner_business` from `owner_individual`, plus counsel on reuse of
clerk records (Texas sale prices are confidential at the appraisal district;
Tax Code 22.27). Until then a deed is stored evidence (L4), never product.

### 9.5 Our slice and the early data pull in different directions

Planning-stage data is richest for multifamily and commercial; that is where
Dodge, ConstructConnect, Shovels and GatherGov sell. Our defensible slice is
residential and light commercial, where the early window is the plan-review
period. The backtest decides how much early-planning value exists in our
slice; if little, we should say "63 days earlier, with the builder's sub
history", not "months earlier".

## 10. What to build, in order (after approval)

| # | Item | Effort | Depends on |
| --- | --- | --- | --- |
| 1 | Resolver fix: legal entity vs name cluster vs brand; stop stripping geographic words | S | None (correctness; separate PR) |
| 2 | Store `propertyrsn`, `project_id`, `peoplersn`; measure `masterpermitnum` resolution and umbrella parents | S | None |
| 3 | P0 backtest job (read-only, ephemeral Postgres) | M | None |
| 4 | P1 competitive side-by-side | S | None |
| 5 | Case-number citation extractor (`SP-`, `C14-`, `C8-` exact patterns) into `official_reference` links | S | 2 |
| 6 | Planning cases for site plans, subdivisions, affordable housing; daily status snapshots | M | 3 shows value, owner approval |
| 7 | Expediter role classifier on plan-review applicants | S | 1 |
| 8 | Evidence ladder L1-L4 in `DATA_MODEL.md` and the Early filings screen | S | 6 |
| 9 | P2 forward test with design partners (E8) | M | 6, 7, 8 |
| 10 | Registry table migration; weekly catalog diff | S | After M1 |

Requests that cost little and run in parallel, each needing the owner's go
because they are outside the project: one City of Austin public-information
request (DSD contractor-of-record at intake, Austin Water SER log; fees from
$0.10 a page), a price and terms enquiry to the Travis County Clerk for its
bulk index, and an open-data request asking Austin to publish plan-review
participant roles.

## 11. Open items and verification gaps

- County, state and procurement sources in Worker A are mostly unopened
  (fetch budget): Travis County GIS, Georgetown planning layers, TCEQ pending
  permits, Comptroller columns (`9cir-efmm`), TBAE and TBPELS roster formats,
  Travis County Clerk terms.
- Whether the Historic Landmark Commission's demolition numbers already appear
  in `3syk-w9eu` or `n8ck-xkda` (if so, the agenda adds little).
- Zoning and Platting Commission and Board of Adjustment board ids and volumes.
- austintexas.gov site terms; whether the edims host sends ETags.
- Zabalist's plan-review coverage (absence untested; P1 answers it).
- Literature conversion rates: none Austin-specific found; external figures
  are unverified. The backtest is the only number the product may use.
