# Data audit, 2026-11-14

Read-only run of `recon/data_audit.js` against the live Neon database
(`data-audit` workflow, runs 43591730415 and 43591845882 on PR #58). Every
number below is from that output unless marked otherwise. Re-run it any time
from the Actions tab; it writes nothing.

## Headline

1. **The database is one day old.** Every source's first sync run is
   2026-11-13. Rows average 1.00 stored versions (plan review 1.03). The
   "history nobody can backfill" that ADR-18 names as our main moat has, as of
   today, one day in it. Discovery latency cannot be measured yet: only 8
   applications are dated on or after our first sync (all seen the same day).
   **Every freshness claim needs two to four weeks of forward data first.**
2. **We already receive valuable fields we throw away.** Raleigh sends a
   contractor email on 92.3% of rows; we store 0 emails anywhere. Miami-Dade
   sends `StructureFloors` (94%), `StructureUnits` (94%), `SquareFootage`
   (69%), `ProposedUseDescription`, `ResidentialCommercial`, last inspection
   dates (76%) and an `ArchitectName` column (100% non-blank, values not yet
   checked); none is mapped. Austin sends `housing_units` (70%),
   `number_of_floors` (72%), `completed_date` (82%), new/remodel square feet,
   `certificate_of_occupancy`. City of Miami sends `TotalDaysInPlanReview`,
   `PlanCreatedDate`, `Miami21Zone`, `PropertyType`, `IsPrivateProvider`.
   Mapping these is the cheapest enrichment there is: no new source, no cost.
3. **Raleigh has no property data at all.** `pin` is on 99.0% of Raleigh
   rows, but no Wake County parcel source is connected (parcel linked: 0.0%).
   17.0% of Raleigh rows have no map point.
4. **Contractor identity is name-based outside Florida.** Austin, Raleigh and
   City of Miami resolve 91-96% of permits, all by name + state; only
   Miami-Dade resolves by licence (82.5%). Phones exist for 81-97% of business
   entities, but only 26-42% are corroborated by a second permit or registry.
   1,163 normalised names in Florida map to more than one contractor entity
   (likely one company with several licences: an under-merge to review).
5. **Official record links are missing for three of four markets.**
   `permit_url` is filled for Austin (100%) and absent for Miami-Dade,
   City of Miami and Raleigh (0%). Rule 6 (provenance on every displayed
   value) is met internally (100% of permits trace to a raw record) but a
   customer can't click through to the source outside Austin.
6. **Sync reliability is good but short.** 100% success on every source in its
   8-20 runs, except Miami-Dade PA (94.4%, one `bad_data`).

## Per-market fill rates (permits table, non-empty share)

| field | Austin permits (58,422) | Miami-Dade (34,229) | Raleigh (31,026) | Austin applications (10,598) | City of Miami (2,722) |
|---|---|---|---|---|---|
| address | 100% | 99.6% | 100% | 99.8% | 100% |
| zip | 99.8% | 0.2% | 100% | 0% | 0% |
| city | 99.9% | 100% | 100% | 0% | 0% |
| valuation (non-zero) | 26.4% | 94.5% | 18.0% | 44.7% | 93.5% |
| permit_url (official link) | 100% | 0% | 0% | 100% | 0% |
| parcel_number | 0% (tcad_id in raw, 99%) | 0% (folio in raw, 99.6%) | 99.4% | 0% (propertyrsn in raw, 100%) | 100% |
| contractor_name | 91.0% | 100% | 93.6% | n/a | 95.6% |
| contractor_phone | 90.6% | 82.4% | 83.4% | n/a | 0% |
| contractor_licence | 0% | 82.5% | 0% | n/a | 0% |
| submitted_on | 100% | 0% | 20.2% | 100% | 0% |
| inspections, fees, construction_type | 0% | 0% | 0% | 0% | 0% |
| owner (stored, never shown) | 0% | 99.6% | 73.9% | 0% | 0% |

## Enrichment coverage

| market | parcel linked | point from source | from parcel | census exact | census other | no point |
|---|---|---|---|---|---|---|
| Austin permits | 84.7% | 62.8% | 0% | 17.7% | 2.2% | 17.3% |
| Miami-Dade | 96.3% | 0% | 96.3% | 0.3% | 0.3% | 3.1% |
| Raleigh | **0%** | 20.2% | 0% | 51.0% | 11.8% | 17.0% |
| Austin applications | 87.1% | 100% | 0% | 0% | 0% | 0% |
| City of Miami | 99.5% | 100% | 0% | 0% | 0% | 0% |

Property attributes on found parcels:

| attribute | Miami-Dade PA (21,381 asked, 99.4% found) | Travis CAD (34,344 asked, 100% found) |
|---|---|---|
| year built | 89.1% | 94.1% |
| living / heated sq ft | 89.1% | 94.2% |
| lot sq ft | 84.4% | 0% (not loaded) |
| bedrooms / bathrooms | 75% / 76% | 0% (not in our extract) |
| units / floors | 73% / 77% | 0% |
| land use | 100% | 0% (not loaded) |
| assessed / market value | 97.0% | 0% assessed; land 80%, improvement 93% |
| improvement type | 0% | 94.6% |
| parcel point | 100% | 0% (not loaded) |

Licence registries: TDLR 2,052 licences (62.2% with phone); Florida DBPR
9,108 (0% phone). Texas has no state GC licence (ADR-14), so 31.7% of Texas
business entities link to a state licence and 0% of North Carolina entities
do (no NC registry connected).

## Contractor and contact coverage (entities)

| state | business entities | any phone | phone corroborated | email / website | state licence | 2+ permits |
|---|---|---|---|---|---|---|
| FL | 7,731 | 80.7% | 25.6% | 0% | 85.7% | 54.4% |
| NC | 3,380 | 86.0% | 39.2% | 0% | 0% | 63.8% |
| TX | 4,718 | 96.7% | 42.1% | 0% | 31.7% | 61.0% |

Individuals (76 FL, 259 NC, 346 TX) have phones stored and hidden (rule 5).

## Links

- Austin applications to permits: 9,890 official links (`masterpermitnum` =
  `folderrsn`, confidence 1.00). 77.8% of applications linked; 86.0% of those
  submitted more than 180 days ago.
- Building jobs with a linked trade permit: Raleigh 78.9%, Austin 52.0%,
  City of Miami 19.9%, Miami-Dade 15.7% (Miami-Dade `MasterPermitNumber` is
  filled on only 28.8% of rows).
- `contractor_relationships`: 10,602 GC-sub pairs.
- Austin applications with a named filer organisation: 66.3%.

## Duplicates

Upper bound (same market, normalised address, permit type and date, different
number): Austin 5.2%, Miami-Dade 4.6%, Raleigh 3.5%, City of Miami 10.1%.
Units in one building legitimately share all four, so this needs a sampled
review before it becomes a defect rate. City of Miami vs the county feed:
0.1% overlap at the same address and date, so the two feeds are not
double-counting each other.

## Storage

936 MB total on Neon Launch: `permits` 338 MB, `raw_records` 286 MB,
`permit_versions` 87 MB, `permit_parties` 56 MB, `parcels` 49 MB.

## Audit limits

- Lag is measured from the source's own date; `filed_date` means different
  things per source (DATA_SOURCES.md).
- Raw-key fill rates are on the newest 2,000 raw records per source; blank,
  `0` and `0000000000` count as empty.
- `ArchitectName` in Miami-Dade is non-blank on every sampled row; whether it
  holds real names or a placeholder is unchecked.

## Prototype parity with `uristeimberg-wq/permit-leads-actor`

Checked 2026-11-14 by cloning the original repository (one commit, `b6a374c`,
2026-11-13, 48 files) and comparing every file with this repository's `main`.

- **Nothing is missing.** 47 of 48 files exist here: 22 byte-identical (all
  of `recon/`, the Accela adapter, `csv.js`, `address.js`, `dates.js`,
  `.actor/`, `Dockerfile`, `docker-compose.yml`, `data/area-coords.json`,
  `package-lock.json`), 25 changed on purpose by later PRs.
- **The one absent file, `db/schema.sql`, became
  `db/migrations/001_baseline.sql`.** Its SQL is identical once comments are
  stripped (checked with a whitespace- and comment-insensitive diff).
- **Sources:** all five original sources (`portland-or`,
  `clackamas-county-or`, `oregon-statewide`, `austin-tx`, `miami-dade-fl`)
  are still defined, plus `austin-plan-review-tx`, `miami-city-fl` and
  `raleigh-nc`. The three Oregon sources are disabled by decision (ADR-5,
  Accela out of the pilot; M0 scheduler defaults). Washington County, OR is
  still deliberately not implemented: its search is CAPTCHA-gated (hard rule 4).
- **API routes:** all eight original routes remain; six were added.
- **Intentional removals inside changed files**, none a lost feature:
  `valuation || 0` became NULL (hard rule 1); the old free-text HVAC,
  plumbing and electrical rules were replaced by ADR-17 trade scoring (the
  trades are still scored); default areas moved from Oregon to the pilot
  markets; the old `ingest_runs` freshness query gave way to `sync_runs` /
  `source_health` (ADR-14), while `ingest_runs` remains in the schema.
