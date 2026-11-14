# Data engine plan

Status: **accepted, 2026-11-14** (ADR-23). Decisions taken are in section 12. It answers the owner's "data is the
product" brief of 2026-11-14, items 1-8 and the nine-step immediate task.

It builds on, and does not repeat:

- `docs/DATA_STRATEGY.md` and ADR-18 (early signals, evidence ladder, source
  registry, P0 backtest, P1 competitor check)
- ADR-14 and ADR-15 (production pipeline, enrichment by official keys)
- ADR-16 (lifecycle), ADR-19 (filers), ADR-21 (estimates)
- `docs/COMPLIANCE.md` (Travis CAD rules, Philadelphia blocked, CC BY credits)

Research behind this plan, in `docs/research/2026-11-14-data-engine/`:

| Report | What it answers |
| --- | --- |
| [`audit.md`](research/2026-11-14-data-engine/audit.md) | What the live database actually holds, per market (read-only `recon/data_audit.js`) |
| [`shovels.md`](research/2026-11-14-data-engine/shovels.md) | Shovels in depth: datasets, coverage, cadence, API, pricing, terms |
| [`property-and-imagery.md`](research/2026-11-14-data-engine/property-and-imagery.md) | Property providers and imagery: fields, price, rights, match quality |
| [`sources-and-contractors.md`](research/2026-11-14-data-engine/sources-and-contractors.md) | New early signals and contractor/contact sources, ranked |

Labels: **[V]** verified on a live page or our database on 2026-11-14,
**[I]** inference, **[U]** unknown.

---

## 1. The answer in one page

**Our data asset today is one day deep.** Every source's first sync run is
2026-11-13 [V audit]. 137k permits and applications, but an average of 1.00
stored versions per row. ADR-18 says the moat is history nobody can backfill;
that history does not exist yet. Discovery latency cannot be measured yet
either. **The most valuable thing we can do this week costs nothing: keep the
daily snapshots running without a gap and start measuring.**

**The cheapest enrichment is data we already receive and throw away.**
Raleigh sends a contractor email on 92% of rows; we store zero emails.
Miami-Dade sends floors and units (94%), square footage (69%), last
inspection dates (76%) and an architect column. Austin sends housing units
(70%) and floors (72%). Three of four markets have no official record link
stored. Raleigh has a parcel id on 99% of rows and no property data at all.
Fixing these is a sprint of mapping work, no new source, no cost [V audit].

**Shovels is a serious, fast-moving competitor, and its terms forbid us from
using it to compete.** ~2,000 jurisdictions, 130M permits, 159M properties, a
zoning "Decisions" dataset, Miami-Dade since September, ~$3M ARR (Sacra
estimate). It is weak where a 2-4 market specialist can be measurably better:
it refreshes twice a month plus up to a week (we sync daily), it keeps one
contractor per permit with no role and no GC-sub model, it dedups contractors
per state with IDs that can change, it keeps current status only, and it
publishes no contact fill rates [V shovels.md]. Its Terms §3(b)(v) bar use
"for the purpose of competing", so **the free-tier side-by-side in
DATA_STRATEGY §7.3 is paused** until counsel or Shovels clears it.

**Property data: county records first, no vendor for the pilot.** Vendors
resell the same county rolls, lag on the same new parcels, and their licences
stop us from redistributing what we buy, which defeats "data is the asset".
Add Wake County parcels (CC BY 4.0, daily) for Raleigh, parcel centroids to
fix Austin's 17% unlocated rows, and keep the Travis CAD and Miami-Dade PA
loaders [V property-and-imagery.md].

**Imagery adds screen value, not asset value.** Google Street View can't be
stored or redistributed, so it never becomes part of the dataset. Show it
live, labelled with distance and capture date, and only after the owner
approves a key with a hard budget cap. Mapillary (CC BY-SA) and NAIP (public
domain) are the only imagery we could keep.

**New early signals worth adding, ranked by value over effort:** Raleigh
`Development_Plans` (open, daily, names the developer; corrects our PADAS note
that Raleigh has no planning feed), Miami-Dade DERM sewer allocation (the
first pre-issue stage for our weakest market, without the $110/mo clerk
feed), Florida Sunbiz daily bulk and the Texas Comptroller API (legal-entity
keys for contractors), FAA obstruction filings (cranes and tall buildings,
with sponsor contacts) [V sources-and-contractors.md].

**Customer validation does not wait for Phase 6.** No customer has shown
willingness to pay. The 4-week builder/supplier list (ROADMAP E8, DATA_STRATEGY
P2) starts in sprint 1 and runs alongside every phase below.

---

## 2. Where the brief is weak (blunt)

1. **"Data is the asset" is true only if someone buys it.** A database
   nobody pays for is a cost. The brief moves the pilot to Phase 6, after
   four phases of infrastructure. That repeats the risk that matters most:
   building for months on an unvalidated buyer. The plan keeps the 4-week
   builder/supplier list running from sprint 1, and gates the expensive
   phases (paid sources, imagery, the data API) on its result.
2. **"Unique, hard-to-find data" mostly does not exist in our markets.**
   ADR-18's five workers and this round's research found no exclusive public
   dataset. What competitors don't have is (a) our snapshots of status
   changes, (b) official links between filings, (c) precise business
   identity and GC-sub history. All three are things we *build*, not things
   we *find*. (a) is one day old.
3. **"Maximum property enrichment" collides with our own rules.** Owner
   names, mailing addresses, exemptions, sale prices, mortgage data and
   assessor photos are either barred (Travis CAD rules, ADR-10, rule 5) or
   personal data we have chosen not to show. The brief lists "transaction
   history", "publicly recorded sales" and "ownership category" as targets.
   Most of that is load-never or internal-only (section 6.4).
4. **"Earlier discovery" has a hard floor for single-family homes.** The
   P0 backtest found pre-application signals for 91.9% of Austin
   multifamily and 80.3% of commercial BPs, but 7.3% of single-family. For
   homes the realistic window is plan review (median 63 days). Every claim
   must be stated by segment.
5. **Buying an API does not make the data ours.** ATTOM, Regrid, Cotality
   and Precisely licences restrict redistribution. Every field bought from
   them is a field we can show but not sell through our own API or exports.
   County data under open terms is the only property data that strengthens
   the asset.
6. **Eight parallel workers is a coordination cost, not free speed.** One
   person reviews and merges. Parallel PRs already collided on migration
   numbers (009). The plan defines eight roles but runs **at most four lanes
   at once** and gives each a file boundary (section 9).
7. **Benchmarking Shovels is legally constrained.** The brief asks for a
   record-level comparison "where legally permitted". Today that means
   public-claims comparison only (section 8).

---

## 3. What we hold today (Phase 1 audit, summary)

Full tables: [`audit.md`](research/2026-11-14-data-engine/audit.md).

| Market | Rows | Contractor resolved | Phone (entity) | Parcel linked | Located | Official link stored | History |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Austin permits | 58,422 | 91.0% (name) | TX 96.7% | 84.7% | 82.7% | 100% | 1 day |
| Austin applications | 10,598 | filer 66.3% | n/a | 87.1% | 100% | 100% | 1 day |
| Miami-Dade | 34,229 | 82.5% (licence) | FL 80.7% | 96.3% | 96.9% | **0%** | 1 day |
| City of Miami | 2,722 | 95.6% (name) | FL 80.7% | 99.5% | 100% | **0%** | 1 day |
| Raleigh | 31,026 | 93.0% (name) | NC 86.0% | **0%** | 83.0% | **0%** | 1 day |

Gaps the audit found, cheapest first:

| Gap | Fix | Cost |
| --- | --- | --- |
| Raleigh `contractoremail` (92%) unmapped; 0 emails stored anywhere | Map to `contact_points` kind `email` (business only, rule 5) | Mapping |
| Miami-Dade `StructureFloors`, `StructureUnits`, `SquareFootage`, `ProposedUseDescription`, `ResidentialCommercial`, `LastInspectionDate`, `ArchitectName` unmapped | Map; check `ArchitectName` values first | Mapping |
| Austin `housing_units`, `number_of_floors`, `completed_date`, sq ft fields, `certificate_of_occupancy`, `propertyrsn`, `project_id` unmapped | Map (ADR-18 item 2 already asks for the keys) | Mapping |
| City of Miami `TotalDaysInPlanReview`, `PlanCreatedDate`, `Miami21Zone`, `PropertyType`, `IsPrivateProvider` unmapped | Map | Mapping |
| `permit_url` 0% for Miami-Dade, City of Miami, Raleigh | Build the official record URL per source, or store the layer + object id as the link | Mapping |
| Raleigh: no parcel source | `wake-parcels` enrichment connector on `pin` | Free source |
| 17% of Austin and Raleigh rows not located | Parcel centroid via `tcad_id` / `pin` before Census | Free |
| Contractor identity by name outside Miami-Dade; 1,163 FL names split across entities | Legal-entity keys (Sunbiz, TX Comptroller); a 200-firm resolution audit | Free / free key |
| Phones corroborated on only 26-42% of entities | Count licence + second-permit + registry agreement as corroboration; report it | Logic |
| Travis CAD lot size, land use, parcel point not loaded | Add allowlisted positions / polygons | Free |
| `inspections`, `fees`, `construction_type` columns 0% everywhere | Fill from Miami-Dade inspection dates; drop or document the rest | Mapping |

---

## 4. Competitive position: Shovels and others

Full analysis: [`shovels.md`](research/2026-11-14-data-engine/shovels.md).
Earlier checks of Zabalist, Dodge, ConstructConnect, Building Radar and
GatherGov: `docs/research/2026-11-14-early-signals/E-*.md`, `P1-*.md`.

| Dimension | Shovels (documented) | Us (measured or buildable) | Who wins today |
| --- | --- | --- | --- |
| Breadth | ~2,000 jurisdictions, ~85% of US population, from 2010 | 4 markets, mostly 2025-26 | Shovels, by far |
| Cadence | Twice monthly + up to 7 days; releases look monthly | Daily sync of daily sources; Miami-Dade weekly | Us, by 1-3 weeks **if** we keep daily runs and show lag |
| Pre-approval | `in_review` statuses; "Decisions" (council stage, 600 cities, beta) | Austin plan review same day; Raleigh pre-issue rows | Us in Austin and Raleigh for building intake; Shovels for council-stage breadth |
| Status history | Current status only | Every change we observe (from 2026-11-13) | Us, once history accrues |
| GC-sub relationships | One contractor per permit, no role | 10,602 GC-sub pairs; trade links Raleigh 79%, Austin 52% | Us |
| Contractor identity | Per-state dedup, IDs can change | Licence-anchored in FL; name-only in TX and NC today | Unproven both sides; we can audit ours |
| Contacts | Phone and email by frequency; no fill rate published | Phones 81-97% of entities; emails 0% (fixable to ~90% in Raleigh) | Unknown |
| Property | 159M-property API | County rolls in 3 of 4 markets | Shovels for breadth; us for depth where we join by official key |
| Provenance | No source-record link on permits | 100% of rows trace to a raw record | Us |
| Price | Free 500 credits/mo; $599 and $999/mo | n/a | n/a |

**Where we compete:** cadence, pre-issue intake, status history, GC-sub
history, provenance and contact completeness, in 2-4 markets.
**Where we don't:** national breadth, property-wide analytics, homeowner
data, warehouse delivery.

**Risk:** Shovels already offers custom cadences on enterprise deliveries and
runs its own collection pipeline. If it moves big metros to daily, our
cadence edge shrinks to days. The durable edges are the model choices (GC-sub,
history, provenance), which are harder for it to retrofit [I].

---

## 5. Sources to add next

Full ranking: [`sources-and-contractors.md`](research/2026-11-14-data-engine/sources-and-contractors.md) section 4.
All need hard rule 10 first: live probe from Actions, fixture, `DATA_SOURCES.md` entry.

| # | Source | Market | Stage it reveals | Value / effort | First step |
| --- | --- | --- | --- | --- | --- |
| 1 | Raleigh `Development_Plans` | Raleigh | Planning (developer, units, sq ft) | 5 / 1 | Probe; P0-style backtest against Raleigh BPs (location links only, no PIN) |
| 2 | Miami-Dade DERM sewer allocation | Miami-Dade | Pre-issue utility certification, `BLDPROCNO` | 4 / 2 | Probe; test `BLDPROCNO` against permit process numbers |
| 3 | Miami-Dade WASD permits requiring allocation | Miami-Dade | Allocation, permit and CO dates | 4 / 2 | Probe with #2 |
| 4 | Austin site plans, subdivisions, affordable housing | Austin | Planning | Approved in ADR-18 #6, pending P0 value (P0 done: MF/commercial lead ~1 yr, 22% convert) | Build as `planning_cases` with daily status snapshots |
| 5 | Florida Sunbiz daily SFTP | Miami | Legal entity, fictitious names | 4 / 2 | One daily file + layouts + fixture; read the usage guide |
| 6 | Texas Comptroller public API | Austin | Legal entity, SOS number, DBA, active status | 4 / 2 | Register for a free key (**owner approval**) |
| 7 | FAA OE/AAA | All | Cranes and tall buildings, sponsor contact | 3 / 2 | One 90-day call per state; count cases inside pilot bounds |
| 8 | City of Miami planning/zoning entitlements | City of Miami | Entitlement | 3 / 1 | Probe fields |
| 9 | LIHTC application logs (TDHCA, FHFC, NCHFA) | All | Affordable MF, months to years early | 3 / 2 | Read one log's columns |
| 10 | OSHA construction inspections | All | Active job sites; safety history | 3 / 2 | Measure name-match rate to our contractors |

**Not now:** Google Places as stored data (terms bar storage and use with a
non-Google map), SAM.gov (contacts restricted), Miami-Dade clerk NOC feed
($110/mo, on hold per owner until Austin passes E), Texas SOS full bulk
($1,350; the $20/week formations feed is the cheap option later).

**Doc corrections found** (to apply with the first source PR): Raleigh does
have a planning feed (PADAS note wrong); `9cir-efmm` is a City of Austin
dataset; Miami-Dade "Permits Requiring Allocation" is a utility layer, not a
hearing view.

---

## 6. Data architecture

### 6.1 Principles (unchanged from ADR-4, ADR-14)

Raw first; idempotent stages; official keys before fuzzy matches; Postgres
only (ADR-2); every value traceable (rule 6); missing is NULL (rule 1).

### 6.2 Target shape

```
sources ─▶ sync_runs ─▶ raw_records ─▶ normalize ─▶ filings (permits, applications, planning_cases)
                                              │
                         ┌────────────────────┼──────────────────────────┐
                         ▼                    ▼                          ▼
                    properties          businesses (legal entity,   filing_links
             (parcel, by official key)   name cluster, brand)     (official ref / parcel+window)
                         │                    │                          │
                         └──────── projects (umbrella over linked filings, one property) ───┘
                                              │
                         field_observations (every value, every source) ─▶ resolved views
                                              │
                         scorecard (weekly, per market) ─▶ data API (read-only, later)
```

What exists: `sources`, `sync_runs`, `raw_records`, `permits`
(filings), `permit_versions`, `permit_links`, `parcels`/`permit_parcels`
(properties), `contractors`/`contact_points`/`registry_licences`
(businesses), `permit_locations`, `filing_filers`. What is new: `properties`
as a stable entity over provider `parcels`, `planning_cases`, `projects`
(DATA_MODEL already sketches it), `businesses` split into legal entity /
cluster / brand (DATA_STRATEGY §6), `field_observations`, and the
`scorecard` tables.

### 6.3 Field-level provenance, confidence and conflicts

The brief asks that every field keep its source, retrieval time and
confidence, and that conflicts are explicit. Today rule 6 is met at the
**row** level (100% of permits trace to a raw record) but not at the field
level for enriched entities, where two sources can disagree (permit says 2
floors, appraiser says 1).

**Rule:** single-source fields on a filing keep row-level provenance (the
raw record already is the evidence; copying 30 fields per permit into an
observation table would roughly double storage for no new information).
**Field-level observations apply where more than one source can supply the
same attribute**: property attributes, business identity and contacts,
project-level facts.

```sql
CREATE TABLE field_observations (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type     TEXT NOT NULL CHECK (entity_type IN ('property','business','project')),
  entity_id       BIGINT NOT NULL,
  field           TEXT NOT NULL,             -- from a fixed vocabulary (src/fields.js)
  value           JSONB,                     -- NULL = source says unknown; absent row = source silent
  value_hash      TEXT NOT NULL,
  source_id       BIGINT NOT NULL REFERENCES sources(id),
  raw_record_id   BIGINT REFERENCES raw_records(id) ON DELETE SET NULL,
  source_ref      TEXT,                      -- e.g. parcel key, licence number, permit number
  method          TEXT NOT NULL CHECK (method IN ('as_published','normalized','derived','matched')),
  confidence      TEXT NOT NULL CHECK (confidence IN ('official','high','medium','low')),
  source_as_of    DATE,                      -- the source's own date (roll year, file date)
  retrieved_at    TIMESTAMPTZ NOT NULL,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rule_version    TEXT NOT NULL,
  UNIQUE (entity_type, entity_id, field, source_id, value_hash)
);

CREATE TABLE field_conflicts (
  entity_type   TEXT NOT NULL,
  entity_id     BIGINT NOT NULL,
  field         TEXT NOT NULL,
  observation_ids BIGINT[] NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('disagree','stale','implausible')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','auto_resolved','reviewed')),
  resolution    TEXT,                      -- which observation won and why
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, field)
);
```

**Confidence is a tier, not a fake decimal:**

| Tier | Meaning | Example |
| --- | --- | --- |
| official | The value is published by the authority that owns it, joined by its own key | Year built from TCAD by `tcad_id`; licence status from DBPR by number |
| high | Published value, joined by a strong but indirect key | Parcel facts joined by folio taken from the permit |
| medium | Joined by exact normalised name + state, or a derived value with a stated method | Phone seen on two permits of the same name-matched business |
| low | Proximity or a single uncorroborated observation | Census "non_exact" point; one permit's phone |

Existing `match_confidence NUMERIC(3,2)` columns map onto these tiers; they
are not removed (rule 9).

**Resolution, per field, deterministic:** a `src/fields.js` table lists, for
each field, the source precedence (for property facts: appraiser > permit;
for floors on a new build: permit > appraiser, because the roll lags
construction), a tolerance (sq ft within 10%, floors exact) and a staleness
limit. The resolved view picks the highest-precedence non-stale observation.
When two observations above `low` disagree beyond tolerance, a
`field_conflicts` row is written: `auto_resolved` when precedence settles it
(and the loser stays visible as "permit says 3 floors"), `open` when it
doesn't. **Nothing is overwritten**; the resolved value is a view over
observations.

**Storage estimate [I]:** ~60k properties × ~12 multi-source fields × ~1.5
sources ≈ 1.1M rows, plus businesses (~17k × ~6) ≈ 0.1M. At ~250 bytes a row
with indexes, about 0.3 GB, or ~$0.10/month on Neon Launch storage.

### 6.4 Property profile: which fields, from where, shown or not

| Group | Fields | Source (in order) | Shown |
| --- | --- | --- | --- |
| Identity | parcel id, standardised situs address, lat/lon, county, municipality | Appraiser by permit's key; parcel centroid; Census | Yes, with source and roll year |
| Use | land use, zoning (Miami21 zone; Austin zoning case) | Appraiser; city zoning layer | Yes |
| Physical | year built, living/heated area, lot size, floors, units, beds/baths, improvement type | Appraiser; permit (new builds) | Yes, "appraisal record, {year}" |
| Value | land, improvement, assessed value | Appraiser | **As a band only** (proposed; counsel Q9) |
| Construction history | all permits, applications, planning cases, inspections, contractors, architects | Our filings + links | Yes |
| Ownership | owner type (business / government / residential) from land-use codes only | Appraiser use codes | Yes, as a category |
| Owner name, mailing address | | | **Never loaded** from appraisers (ADR-10, rule 5) |
| Sale price | | | **Never** in Texas; not loaded in FL/NC until the homeowner track passes |
| Sale date | | Miami-Dade PA, Wake | Internal recency flag only, after counsel review |
| Exemptions, owner-occupied, mortgage, assessor photos/sketches | | | **Never loaded** |

### 6.5 Imagery

Design in `property-and-imagery.md` §4.3: Street View Static, called at view
time, never stored; free metadata call first; accept a panorama within 40 m
on the parcel's frontage; label every image with distance, capture date and
a high/medium/low tier; say "before this permit" when the capture predates new
construction; show nothing rather than a wrong building. Mapillary and NAIP as
stored fallbacks with credits. A `suppressions` kind `parcel_image` for
removal requests. **Open:** read Google's "non-Google map" clause before
build (our map is Leaflet/OSM; the image would sit on the job page, not the
map).

This is UI work under the freeze, so it ships only after sprint 2 and only
if the owner approves the key (section 11).

### 6.6 Data API (later)

Read-only JSON over the resolved views, same signed-access model as the
digest links (ADR-20), every value with its source, as-of date and tier.
Built only after the pilot shows a buyer wants data rather than lists. Its
licence must respect each source's terms (CC BY credits travel with the
data; Travis CAD rules apply; no vendor-licensed fields).

---

## 7. Data-quality scorecard

Measured weekly by an extension of `recon/data_audit.js` that writes one
`scorecard_snapshots` row per market and metric (the only write it makes),
so trends are queryable and the health alarm can watch them. Baselines are
the 2026-11-14 audit. Targets are for **day 30 and day 90 after approval**.
Every rate is paired with a precision check on a hand-checked sample,
because a rate without precision rewards bad matches.

| Metric | Definition | Baseline | Day 30 | Day 90 |
| --- | --- | --- | --- | --- |
| Application capture | Share of new BPs first seen as an application before issue | Austin ~100% (every BP has a plan-review case); Raleigh pre-issue rows only; Miami 0 | Austin ≥95%, Raleigh ≥70% | + Miami-Dade ≥30% via DERM, if it links |
| Pre-application capture | Share of new-construction BPs with an earlier planning/utility signal, and median lead over the application, **by segment** | Austin backtest: MF 91.9% (363 d), commercial 80.3% (385 d), SF 7.3% | Live measure for Austin | Austin + Raleigh, each segment reported; no single headline number |
| Discovery latency | Our `first_seen_at` minus the source's own timestamp, p50 / p90 | Not measurable (1 day of data); plan review 0 d on 8 rows | Measured on ≥2 weeks of forward rows | p50 ≤1 d, p90 ≤2 d for daily sources; ≤8 d for Miami-Dade weekly |
| Customer-visible lag vs Shovels' documented window | Same, compared with 0-22 days | n/a | Reported | ≥10 days better at p90, or the claim is dropped |
| Property match rate | Share of filings linked to a parcel by official key | Austin 84.7%, Miami-Dade 96.3%, City of Miami 99.5%, Raleigh 0% | Raleigh ≥90% | All ≥95%, precision ≥98% on a 200-row sample |
| Location coverage | Share with a map point; share "approximate" | Austin and Raleigh 17% unlocated | ≤8% unlocated | ≤3% unlocated |
| Property enrichment depth | Median of 8 core attributes (land use, year built, living area, lot, floors, units, value band, beds/baths) present on linked parcels | Miami-Dade ~7/8, Austin ~4/8, Raleigh 0 | Austin ≥6, Raleigh ≥5 | All ≥6 |
| Official record link | Share of filings with a source URL a customer can open | Austin 100%, others 0% | 100% where the source has a stable URL; else layer+id documented | 100% |
| Contractor match rate | Share of filings resolved to a business entity | 82.5-95.6% | Unchanged or better | ≥95%, and wrong-merge ≤1%, split ≤3% on a 200-firm audit |
| Legal-entity anchoring | Share of business entities tied to a licence or registry key | FL 85.7%, TX 31.7%, NC 0% | TX ≥60% (Comptroller), FL ≥90% (Sunbiz) | NC ≥50% |
| Contact coverage | Share of active business entities with a phone; with an email | Phone 81-97%; email 0% | Raleigh email ≥85% | Email ≥50% overall |
| Contact corroboration | Share of shown phones seen on 2+ permits or matching a licence | 26-42% | ≥50% | ≥60%, plus a 50-call answer check before any "verified" claim |
| Historical linkage | Application → permit link rate on applications older than 180 days; building jobs with a linked trade permit | 86.0%; Austin 52%, Raleigh 79%, Miami-Dade 16% | ≥90% applications | Miami-Dade trade links explained or ≥40% |
| Duplicate opportunity rate | Share of delivered opportunities that duplicate another, on a sampled review | Upper bound 3.5-10% (unreviewed) | Measured | ≤1% |
| History depth | Days of continuous daily snapshots per source, gaps counted | 1 | 30, no gap | 90, no gap |
| Source reliability | Share of scheduled runs that succeed; time to alarm on a stale source | 94-100% on 8-20 runs | ≥99%, alarm ≤6 h | Same |
| Unique opportunity coverage | Share of our open opportunities on a date that an issued-permit search would not show (pre-issue, not yet issued) | Austin ~1,370 applications in review/corrections/submitted on 2026-11-14 | Reported weekly by segment | Validated against the pilot's "new to me" answers |

**What is deliberately not a target:** total record count. Adding 500k old
permits from a new county would raise it and lower every other line.

---

## 8. Benchmark methodology

1. **Public-claims benchmark (allowed now, $0).** Compare our measured
   scorecard with Shovels' published cadence, coverage, field model and
   dedup scope, each claim cited with URL and date. Same for Zabalist's
   public pages.
2. **Our own lag against their documented window.** Discovery latency
   (section 7) against "twice monthly + up to 7 days". Needs no Shovels data.
3. **Coverage page check by a person.** A human notes whether Austin,
   Miami-Dade, City of Miami and Raleigh appear on `shovels.ai/coverage`,
   with date ranges. No scraping; keep only yes/no and the date.
4. **Record-level side-by-side: only with written permission.** Either ask
   Shovels in writing for an evaluation licence that permits comparison, or
   have counsel read the Terms. If cleared: 50 sealed permits per market
   chosen in advance, looked up at D+1, D+7, D+14, D+21, recording only
   present / first seen / status / contractor match / phone present / trade
   links, deleted at the end. **Owner decision** (section 11).
5. **Customer benchmark (the one that matters).** In the 4-week pilot, each
   partner marks each item "new to me / already knew / not relevant". That
   is the unique-opportunity metric measured by the buyer, not by us.

Until 4 clears, customer-facing copy compares against Shovels' **published
documentation** only, never a head-to-head we have not lawfully run.

---

## 9. Workers: roles, boundaries, first deliverables

Eight roles as the owner asked, run as **at most four concurrent lanes**,
each owning a file boundary so parallel PRs don't collide. Migration numbers
are claimed in the PR title before work starts (the 009 collision).

| # | Role | Owns (files) | First deliverable (sprint 1-2) | Lane |
| --- | --- | --- | --- | --- |
| 1 | Data Source Discovery | `recon/preapproval_scan.js`, `recon/source_registry.js`, `docs/research/`, `DATA_SOURCES.md` entries | Probes and fixtures for sources 1-3 and 7-9 (section 5); doc corrections | A |
| 2 | Ingestion Engineering | `src/sources.js`, `src/adapters/`, `ingest/run.js`, `ingest/lifecycle.js` | Map the unmapped fields and official links (section 3); Raleigh `Development_Plans` and Austin planning cases connectors | B |
| 3 | Property Enrichment | `src/enrichment/parcels.js`, `ingest/enrich_*.js`, `ingest/geocode.js` | `wake-parcels` connector; parcel-centroid locations; Travis CAD lot/land use; later imagery | C |
| 4 | Contractor Intelligence | `src/enrichment/licences.js`, `ingest/enrich_licences.js`, contact logic | Raleigh emails as business contacts; Sunbiz and Comptroller loaders; corroboration rules | D |
| 5 | Entity Resolution | `src/contractors.js`, `src/filers.js`, `ingest/resolve.js`, link code | 200-firm resolution audit; legal entity / cluster / brand split; projects grouping | D (after 4's loaders) |
| 6 | Data Quality | `recon/data_audit.js`, `ingest/health.js`, scorecard tables, `test/` | Scorecard snapshots + alarm thresholds; sampled precision checks; duplicate review | A (alternates with 1) |
| 7 | Competitive Intelligence | `docs/research/` competitor files | Public-claims benchmark; Shovels written request draft (owner sends); Zabalist recheck | A, light |
| 8 | Data Architecture | `db/migrations/`, `docs/DATA_MODEL.md`, `docs/ARCHITECTURE.md`, `src/fields.js` | `field_observations` / `field_conflicts` / `properties` / `scorecard_snapshots` migrations and the resolution table | C (before 3's new loaders write observations) |
| — | Minimal frontend | `web/` | Data-inspection only: show a value's source, tier and conflicts on the existing job/contractor pages; scorecard table on the admin page. No visual work | B, small |

Shared documentation: this plan, `DATA_MODEL.md` (schema), `DATA_SOURCES.md`
(one entry per source, dated), `DECISIONS.md` (ADRs), and the scorecard.

---

## 10. Prioritised implementation plan

The owner's six phases, re-cut so the pilot starts at once and every phase
ends in a scorecard check. Sprints are two weeks [I: effort estimates].

| Sprint | Phases | Build | Exit check |
| --- | --- | --- | --- |
| 0 (now) | 1 Audit | Done: `recon/data_audit.js`, this plan | Owner approves or edits ADR-23 |
| 1 (wk 1-2) | 3 Ingestion, 4 Enrichment | Map unmapped fields and official links (all 4 markets); Raleigh emails; `wake-parcels`; parcel-centroid locations; `field_observations` + `scorecard_snapshots` migrations; weekly scorecard job | Scorecard day-30 lines for property match, location, official link and email met or explained; 0 duplicate rows on re-run |
| 1 (in parallel) | 6 Pilot | Recruit 3-5 Austin builders/suppliers from our own data (DATA_STRATEGY P2); daily homes-first list starts (the screen and digest already exist) | Partners signed up; first week's "new to me" answers logged |
| 2 (wk 3-4) | 2 Sources, 3 Ingestion | Raleigh `Development_Plans`; Miami-Dade DERM + WASD (if probes pass); Austin site plans / subdivisions / affordable housing as `planning_cases` with daily status snapshots; FAA probe | Pre-application capture measured live in Austin; Raleigh backtest run; Miami-Dade pre-issue link rate measured |
| 2 (in parallel) | 4 Enrichment | Sunbiz + Comptroller entity keys (Comptroller key needs approval); 200-firm resolution audit; corroboration rules | Legal-entity anchoring and wrong-merge rate reported |
| 3 (wk 5-6) | 4 Enrichment, 5 Validation | `properties` and `projects` entities; resolution and conflicts live for property and business fields; public-claims benchmark; pilot ends (4 weeks) | Pilot verdict (3 of 5 "new and early enough" weekly, or stop and rethink); conflicts queue reviewed |
| 4 (wk 7-8) | 5 Validation, then 4 imagery | Day-90 scorecard dry run; imagery behind a capped key if approved; data API design only if the pilot asks for data | Go / no-go on paid sources, imagery and API, decided on scorecard + pilot evidence |

**Always on, from day 1:** daily snapshots without gaps (history depth is
the asset); the health alarm; `npm test` green; no UI polish.

---

## 11. Costs and approvals the owner must give

| Item | Monthly cost | Needs |
| --- | --- | --- |
| Neon Launch storage for the new tables | ~$0.10-0.50 more (0.3-1.5 GB at $0.35/GB) | Nothing (already on Launch) |
| County sources (Wake, Travis CAD, Miami-Dade PA), Sunbiz, FAA, Census, NAIP, Overture | $0 | Nothing beyond terms review |
| Texas Comptroller API key | $0 | **Owner approval** to register |
| Google Street View Static + metadata | $0 in the pilot (10k free/mo); ~$70 at 20k views | **Owner approval**: Google Cloud billing account, key with a daily quota cap and budget alert |
| Mapillary token | $0 | **Owner approval** |
| Texas SOS new-formations feed | $20/week (optional, later) | **Owner approval** |
| NC SOS bulk, NCLBGC records request | Price unknown / request fees | **Owner approval** to ask |
| Shovels evaluation (record-level benchmark) | $0 if they grant it; $599/mo if paid | **Owner decision**: write to Shovels, or counsel first, or skip |
| Counsel questions (owner-type display, value bands, sale-date use, NC telephone statute, Shovels terms, TX ch. 302) | Counsel time | Owner |
| ATTOM, Regrid, Cotality, Precisely, Nearmap, EagleView | $500-5,000+ | **Not recommended** for the pilot |

**Recommended stack total: $0-75 a month** plus counsel time. Nothing is
signed up for or spent without the owner's go.

---

## 12. Decisions (taken 2026-11-14)

The owner approved the plan, chose to skip the Shovels record-level
benchmark, and left the rest to the recommendation:

1. **Plan approved** (ADR-23 accepted). The pilot runs from sprint 1.
2. **Shovels record-level benchmark: skipped.** No account, no written
   request. Section 8 steps 1-3 and 5 only (public claims, our own lag, a
   manual coverage-page note, the pilot's "new to me" answers).
3. **Property values: shown as bands** (for example "$250k-500k"), labelled
   "appraisal estimate, {year}", never exact. Counsel Q9 stays on the list;
   if counsel objects, bands come off.
4. **Imagery: deferred to sprint 4** and only if the pilot shows customers
   want it. No Google key until then.
5. **Texas Comptroller API key: yes.** The owner registers (it needs the
   owner's own account details); the loader is built against the documented
   API and a fixture meanwhile.
