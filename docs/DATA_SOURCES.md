# Data sources

Last verified: **2026-11-13**, by fetching each endpoint live. Anything not
marked verified is an assumption. Update the date and the numbers whenever a
source is re-checked. Never add a source here without fetching it.

## Pilot sources

### Austin, TX: Issued Construction Permits

| Field | Value |
| --- | --- |
| Endpoint | `https://data.austintexas.gov/resource/3syk-w9eu.json` (Socrata SODA) |
| Metadata | `https://data.austintexas.gov/api/views/3syk-w9eu.json` |
| Auth | None needed. An app token raises the rate limit (to obtain) |
| Licence tag | `USGOV_WORKS`. Attribution: "City of Austin, Texas - data.austintexas.gov". Terms read 2026-11-13 (see the licence review): public domain, "offered free and without restriction" |
| Freshness | Rows updated 2026-11-12; latest `issue_date` 2026-11-11 (verified) |
| Volume | 6,636 permits issued 2026-10-01 to 2026-11-11 (verified), about 158/day across all types. The prototype README says 2.37M records are available in total |
| Contractor | `contractor_trade`, `contractor_company_name`, `contractor_full_name`, `contractor_phone`, `contractor_address1/2`, `contractor_city`, `contractor_zip`. Phone on 92% of rows per the prototype README |
| Applicant | `applicant_full_name`, `applicant_phone` (mapped by the prototype) |
| Owner | No owner field seen |
| Property | `original_address1`, `original_city`, `original_state`, `original_zip`, `tcad_id` (parcel), `legal_description` |
| Value | Many valuation columns, most empty. Taking the first non-zero lifts coverage from 7% to about 25% (prototype) |
| Status | `status_current`, `statusdate`, `applieddate`, `issue_date`, `expiresdate`, `completed_date` |
| Limits | **Issued permits only**: almost nothing awaiting approval. Pending applications would need a different dataset (to look for) |
| Sync mode | `date_window` (ADR-11): `issue_date` last 30 days plus `statusdate` last 14 days. `:updated_at` is **not usable**: all 2,385,068 rows moved between 15:18 and 15:47 UTC on 2026-11-12, a daily full reload (measured 2026-11-13) |
| `statusdate` | Populated on every row; latest 2026-11-12. 5,614 status changes in 7 days, 74% of them on permits issued 30+ days ago (measured 2026-11-13) |
| Integration status | Working in the prototype (`austin-tx`) |
| `:created_at` | **Useless for lag.** All 9,863 rows issued in the last 60 days carry `:created_at` 2026-11-12: the dataset is bulk-reloaded (measured 2026-11-13) |
| Measured 2026-11-13 | See "M1 measurements" below |
| Coordinates | `latitude`, `longitude`, `location`: 84.4% of all rows, only 60.6% of permits issued in the last 90 days (2026-11-13). See "Enrichment sources" |
| Parcel join | `tcad_id` (99.5% filled) equals TCAD `geo_id` for 90.8% of distinct values (2026-11-13) |

### Miami-Dade County, FL: permit data layer

| Field | Value |
| --- | --- |
| Endpoint | `https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0` (ArcGIS REST table) |
| Auth | None |
| Terms | Item `6db5f56e886446df88313ca279e59120`: licence field is a disclaimer only ("as is", no responsibility for errors). County site disclaimer: no grant, "rights not expressly granted herein are reserved", no attribution rule. Read 2026-11-13; see `docs/COMPLIANCE.md` 1.2 |
| Freshness | `dataLastEditDate` 2026-11-07 (verified), `hasStaticData: true`. Looks like a weekly full replace (to confirm over 3 weeks) |
| Volume | **489,896 rows**, issued 2020-01-01 to 2026-11-05 (server count and statistics, 2026-11-13). The earlier 139,389 count was wrong. 106,070 rows in the last 18 months |
| Paging | `maxRecordCount` 1000. The prototype found that `--max=6000` fails and pages of 500 work |
| Contractor | `ContractorNumber` (licence), `ContractorName`, `ContractorAddress`, `ContractorCity`, `ContractorState`, `ContractorZip`, `ContractorPhone`. Phone on 82% per the prototype README |
| Owner | `OwnerName` (stored, never displayed in v1) |
| Property | `PropertyAddress`, `City`, `State`, `FolioNumber` (parcel), `LegalDescription1/2`. **No ZIP** |
| Project | `MasterPermitNumber`, `ProcessNumber`, which allow an official project link |
| Work | `ApplicationTypeDescription`, `DetailDescriptionComments`, `ResidentialCommercial`, `ProposedUseDescription`, `Category1..10` with descriptions, `SquareFootage`, `StructureUnits`, `StructureFloors`, `EstimatedValue` (string) |
| Dates | `ApplicationDate`, `PermitIssuedDate`, `LastInspectionDate`, `LastApprovedInspDate`, `CoCcDate` (string) |
| Status | **No status column.** Stage is derived from dates (`src/sources.js`) |
| Unknowns | Does it include municipal permits (Miami, Hialeah, Miami Beach, ...) or only county-processed ones? **Still unknown**: `City` is `MIAMI` on 98% of rows, so it is a mailing city, not the municipality. Needs a geographic check (addresses or folios against municipal boundaries) |
| Master permit | `0000000000` is the "no master" sentinel, not a value. 11,290 distinct real masters in the last 18 months |
| Sync mode | `snapshot`: when `dataLastEditDate` changes, page through the whole layer and diff by hash |
| Coordinates | None: the layer is a table with no geometry. Use the Property Appraiser layer via `FolioNumber` (99% match, 2026-11-13) |
| Integration status | Working in the prototype (`miami-dade-fl`) |

### Austin, TX: Plan Review Cases (`austin-plan-review-tx`)

`https://datahub.austintexas.gov/resource/n8ck-xkda.json`, read live
2026-11-13 by `fixture.yml` (fixture `test/fixtures/sources/austin-plan-review-tx.json`,
people's names and addresses redacted). Licence: Public Domain (dataset
metadata); same portal terms as Issued Construction Permits.

- **What it is:** building applications (folder type `PR`) from intake to plan
  approval, before the permit exists in `3syk-w9eu` (ADR-16 E1).
- **Fields used:** `permit_number` ("2026-149359 PR"), `sub_type`
  (permit type), `folder_description`, valuation columns, `status_current`,
  `status_date`, `applied_date` (official submission), `web_link.url`,
  `project_name` (the address when it starts with a house number; otherwise a
  project title, stored as no address), `location` (GeoJSON point),
  `appraisal_id` (= Travis CAD geo id), `folderrsn` (the link key).
- **Not used:** `applicant_*`, `owner_*`, `other_*`. There is no contractor at
  this stage; applicants are builders, owners and permit expediters, and
  individual names are never shown (hard rule 5). They stay in the raw payload.
- **No** city or zip column.
- **Statuses seen and their stage** (`src/sources.js` `lifecycle`): Pending and
  Intake Pending -> submitted; In Review and Prerequisite Review Approved ->
  in_review; Application Incomplete and Awaiting Update -> corrections;
  Approved -> approved (plans approved, not an issued permit); VOID ->
  cancelled; Aborted -> withdrawn. Others are `unknown` and reported by
  `ingest/lifecycle.js`.
- **Link to the issued permit:** the building permit's `masterpermitnum`
  equals the case's `folderrsn` (`permit_links`, `official_reference`, 1.00).
  Checked on 4 samples (PR #43); the rate at scale is printed by each sync.
- **Sync:** windows on `applied_date` (30 days) and `status_date` (14 days).

## M1 measurements (2026-11-13)

From `recon/feasibility.js`, run in GitHub Actions against the live APIs over the
last 18 months (Actions run 43426039322). Re-run with the `feasibility` workflow.

**Austin**

| Measure | Value |
| --- | --- |
| Permits issued in the last 90 days | 14,610 |
| With a contractor phone (10+ digits) | 91.4% (BP 96.2%, MP 97.6%, EP 94.7%, PP 82.2%, DS 55.1%) |
| With a company name | 91.6% |
| Distinct companies / distinct phones | 2,546 / 2,552 |
| Phones shared by 2+ company names | 49 |
| Arrival by issue-date age | Days 0-1: 0% of a normal weekday. Day 2: 47%. Day 3 onward: about 100%. So permits appear 2-3 days after issue. This is a proxy from issue-date counts, not snapshots; the 14-day snapshot in M2 confirms it |
| `masterpermitnum` present | 59.3% of rows, but it does **not** link a building permit to its trade permits (1 link in 4,501) |

Trade gap. Primaries are 4,501 residential BP new, addition or remodel permits
issued 6 to 18 months ago.

| Trade | Linked by permit-number base | Linked by parcel, -30..+180 d | Median days after BP (base / parcel) | Issued 7+ days after BP (base / parcel) | Same company as the BP |
| --- | --- | --- | --- | --- | --- |
| Electrical | 78.0% | 87.7% | 34 / 21 | 85% / 72% | 2-3% |
| HVAC | 50.0% | 62.2% | 63 / 50 | 87% / 77% | 3% |
| Plumbing | 68.1% | 80.0% | 25 / 19 | 78% / 66% | 4-5% |

The permit-number base (`2026-104544 BP` and `2026-104544 EP`) is the stricter
link. The parcel link adds about 10 points but can pick up an unrelated job on
the same lot.

**Austin: plan-review timing and sub hiring (2026-11-13)**

From `recon/plan_review.js`, run in GitHub Actions against the live API (run
43427470550). 108,147 BP, EP, MP and PP rows issued 2024-11-13 to 2026-11-13.

*1. Building-permit review time* (`applieddate` to `issue_date`), residential
BP new, addition or remodel, issued in the last 18 months (n = 6,796; 100% have
`applieddate`; no negative durations):

| Group | n | p10 | p25 | Median | p75 | p90 |
| --- | --- | --- | --- | --- | --- | --- |
| All | 6,796 | 18 | 31 | **63** | 133 | 300 |
| New | 4,865 | 18 | 29 | 61 | 130 | 296 |
| Addition / remodel | 1,931 | 19 | 35 | 69 | 139 | 311 |

Under 8 days: 1.8%. Over 90 days: 35.7%. Median by issue quarter: 2025-Q2 61,
Q3 72, Q4 80, 2026-Q1 70, Q2 51, Q3 54, Q4 (partial) 59. The city's targets
from 2026-07-01 are 10 business days for new construction and 5 for remodels
(austintexas.gov/development-services/residential-plan-review); the measured
elapsed time includes applicant correction cycles, so it is not a test of
those targets. No current open dataset of applications still in review was
found (`7aas-g4y3` stops in 2019; `n8ck-xkda` was last modified 2022).
*Correction (2026-11-13):* `n8ck-xkda` on `datahub.austintexas.gov` is current
(cases applied the same day are published that afternoon). It is now a pilot
source; see "Austin, TX: Plan Review Cases" above.

*2. Trade-permit application dates carry no hiring signal.* For 6,928
residential BPs issued 6 to 24 months ago, linked to their trade permits by
permit-number base, the trade permit's `applieddate` equals the BP's
`applieddate` on 100% of electrical and HVAC and 99.7% of plumbing permits.
Austin creates the trade sub-permits with the building permit, so their
application date says nothing about when a sub was chosen. The dataset
contains issued permits only, so a trade permit (and its contractor name)
first becomes visible when it is issued: the lead already has a sub by then.
The trade **issue** date (median 25-63 days after the BP, above) stays the
only timing signal, and it is an upper bound on when the sub was hired.

*3. GC-to-sub stickiness is very high.* Of 13,868 BP-to-trade pairs where both
companies are named and differ, a pair is "eligible" when the same GC had an
earlier job in that trade inside the window, and a "repeat" when it went to a
sub that GC had already used for that trade.

| Slice | Pairs | Eligible | Repeat rate |
| --- | --- | --- | --- |
| All | 13,868 | 11,002 | **93.9%** |
| Electrical / HVAC / plumbing | 5,341 / 3,805 / 4,722 | | 92.7% / 95.2% / 94.1% |
| GCs with 20+ residential BPs in 24 months | 7,858 | 7,688 | 97.8% |
| GCs with 5-19 | 3,008 | 2,398 | 86.8% |
| GCs with 1-4 | 3,002 | 916 | 79.5% |

For the 438 GC-trade combinations with 5+ named jobs, the median share going
to the GC's single top sub is 92% (83% pooled). GCs with 20+ BPs pull 49.8% of
residential BPs; GCs with 1-4 pull 26.5%. Upper bound on jobs that were open
to a new sub: first-in-window pairs plus non-repeats, 3,541 of 13,868
(**25.5%**), and that overstates it, because a GC's earlier jobs before the
window are not seen. Caveat not yet checked: if a GC routes trade permits
through one permit expediter whose name is on the permit, that inflates the
repeat rate; a hand check of the top 30 trade company names would settle it.

*Conclusion: caution, close to no-go for the pitch "reach the sub before the
job is awarded".* Review time is not the main risk; relationships are. Three
quarters or more of residential trade work in Austin goes to a sub the GC
already uses, and half of all residential BPs come from volume builders who
reuse the same sub 98% of the time. What the data supports instead is
relationship intelligence: who builds what with which subs, which GCs are new
or small (the 1-4 BP tier, where up to 76% of pairs were not a known repeat),
and when a GC switches subs. Design partners should be asked about that
product, not only about timing.

**Miami-Dade**

| Measure | Value |
| --- | --- |
| Rows, last 18 months | 106,070 (issued 2025-05-13 to 2026-11-05) |
| Lag | Latest issue 2026-11-05 against a layer edit on 2026-11-07: weekly refresh, so leads are 2 to 9 days old |
| With a contractor phone | 82.2% |
| Child permits under a real master, median days after the master | ELEC 37 (n=10,169), PLUM 25 (n=6,012), MECH 74 (n=3,057), BLDG 92 (n=3,537) |

## Candidate sources (verified fields, not integrated)

| Source | Endpoint | Freshness (verified) | Contractor fields | Notes |
| --- | --- | --- | --- | --- |
| Dallas, Building Permits | `https://www.dallasopendata.com/resource/e7gq-4sah.json` | Updated 2026-11-12 | One free-text `contractor` field, sometimes with phone and address. **2026-11-13: empty on the 2,000 most recent rows** (see the expansion scan) | `issued_date` is text `MM/DD/YY`, so sort and filter need parsing. No status column. Dallas also publishes "Active Contractors" (`jhgk-eg9m`) with phone |
| Orlando, Permit Applications | `https://data.cityoforlando.net/resource/ryhf-m453.json` | "Updated daily"; updated 2026-11-12 | `contractor_name`, `contractor_phone_number`, `contractor_address` | Property and parcel owner names. About 1.1M rows. Applications, so earlier than issued |
| Chicago, Building Permits | `https://data.cityofchicago.org/resource/ydr8-5enu.json` | Updated 2026-11-12; latest issue 2026-11-11 | Contact slots by role (`contact_n_type/name`), city, state and ZIP only, **no phone** | Large volume. Needs phone enrichment |
| City of Miami, iBuildPermits | `https://gis.miami.gov/gis/rest/services/Maps/iBuildPermits/MapServer/0` | Latest issue 2026-11-13 | **None** | Has `MasterPermitNumber`, `FOLIO`. Use only if the county layer lacks City of Miami permits |
| Seattle | `https://data.seattle.gov/resource/76t5-zqzr.json` | Updated 2026-11-12 | `ContractorCompanyName` only | |
| Los Angeles | `https://data.lacity.org/resource/pi9x-tg5x.json` | Updated 2026-11-09; latest issue 2026-11-07 | None seen | |
| San Francisco | `https://data.sf.gov/resource/i98e-djp9.json` | Updated 2026-11-12 | None in the main table; a separate contacts dataset (`3pee-9qhc`) | |
| Phoenix, ShapePHX permits | `https://mapportal.phoenix.gov/pds/rest/services/ShapePHX/ShapePHXPermitsPoints_DL/MapServer/0` | "Updated on a weekly basis" | One `CONTACT` field (contents unknown) | `OWNER_NAME`, `APN` |
| Mecklenburg County (Charlotte) | metadata only | Weekly; metadata from 2019 | None | CO-required permits only. Skip |

## Expansion market scan (2026-11-13)

Goal: rank US jurisdictions beyond Austin and Miami-Dade where permits can be
ingested legally and reliably, weighted by volume and by how well the data
supports the GC-sub relationship view (a building permit linked to the trade
permits on the same job, with a different company named on each).

**Method.** All numbers come from live API calls made from GitHub Actions on
2026-11-13 (the sandbox cannot reach government hosts), with
`recon/market_scan.js` and `recon/market_links.js` (`feasibility` workflow,
inputs `markets`, `market_cities`, `market_links`; runs 43438702588,
43440944714, 43442610269, 43443947497). Discovery swept Socrata's public
catalog (456 permit datasets), ArcGIS Online search (243 permit services) and
7 CKAN portals, then probed about 55 datasets. Terms pages were read through a
web fetch, not from Actions.

- *Volume* = permits issued in the last 90 days (2026-08-15 to 2026-11-13),
  all types, from a server-side count.
- *Phone* and *company* = share of the 1,000-2,000 most recent rows with a
  10-digit contractor phone / a contractor company name.
- *Link* = residential building permits issued 12 to 6 months ago that get an
  electrical / plumbing / mechanical permit on the same key within -30..+180
  days; *sub differs* = share of those links where the trade permit names a
  different company than the building permit. Same definition as Austin's
  trade gap (Austin: 50-78% by permit-number base).
- **Verified** means measured as above. **Assumed** means not measured.

### Ranked table

| # | Market | Source (endpoint) | Volume, 90 d | Fresh (latest issue) | Phone | Company | Link key: E / P / M linked, sub differs | History | Terms | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **City of Miami, FL** | ArcGIS `services1.arcgis.com/CvuPhqcTQpZPT9qY/.../Building_Permits_Since_2014/FeatureServer/0` | 7,815 | Daily (2026-11-12) | 0% | 96% | `ApplicationNumber`: E 45%, P 43%; sub differs 99% / 87%. Mechanical not found (suffix `ME` is rare; `MA` unknown) | 2012- | **CC BY 4.0** (item metadata) | Add first: same market as the pilot, fixes the county layer's weekly lag and the open municipal-coverage question. Phones must come from the county layer or licences |
| 2 | **Philadelphia, PA** | ArcGIS `services.arcgis.com/fLeGjb7u4uXqeF9q/.../PERMITS/FeatureServer/0` | 11,249 | Daily (2026-11-12) | 0% | 86% | `parentjobid`: E 51%, P 54%, M 36%; sub differs 96% / 94% / 56%. Parcel: 64% / 67% / 48% | 2007- | **Blocked**: city terms prohibit commercial use without written permission (licence review below) | Strong GC-sub links, but no phone, and not usable without the City's written permission |
| 3 | **Raleigh, NC** | ArcGIS `services.arcgis.com/v400IkDOw1ad7Yad/.../Building_Permits/FeatureServer/0` and `.../Permits_Other_Than_Buildings/FeatureServer/0` | 1,482 building + 6,046 trade | Daily (2026-11-12) | 76% building, 86% trade; email 85-91% | 88-97% | `pin`: E 85%, M 73%, P 72%; sub differs 97-98%; **median 0 days** (trade permits are issued with the building permit). `contractortype` names the trade; half the trade rows are `workclass = "Sub Permit"`. `projectname` links only 14% | 2000- | Open Raleigh Data Policy (see the licence review below) | Strongest GC-sub view measured, Austin included. No timing gap, so it supports relationship intelligence, not "reach the job first" |
| 4 | **Orlando, FL** | Socrata `data.cityoforlando.net/resource/ryhf-m453.json` | 6,666 | Daily (2026-11-12) | 51% | 96% | `parcel_number` only: E 34%, P 29%, M 26% (median 8-33 d); sub differs 96-99% | 1907- (bulk from about 2000) | No terms on the portal page; "Legal" link not read | Asked for by the user. Workable, but half the phones are missing and the link is parcel-only, so it is noisier than Austin |
| 5 | **New Orleans, LA** | Socrata `data.nola.gov/resource/72f9-bi28.json` | 5,580 | Daily (2026-11-11) | 0% | 76-90% | `pin`: E 48%, P 38%, M 31% (median 50-59 d); sub differs 90-98% | 2001- | **CC0 1.0** (dataset metadata, verified) | Cleanest licence; has contractor licence and trade; needs phone enrichment |
| 6 | **New York City, NY** | Socrata `data.cityofnewyork.us/resource/rbx6-tga4.json` (DOB NOW Build) + `dm9a-ab7w.json` (electrical) | 43,737 + 13,309 | Daily (2026-11-11) | 0% | 100% (permittee business) | `bin`: P 55% (sub differs 99%), M 45% (36%: the GC often holds it). Job number: P 33%. Electrical is a separate dataset keyed by BIN (not linked here) | 2016- | NYC.gov: "All rights are reserved"; Open Data portal terms page failed to load. **Unread** | Largest volume by far, but dense multifamily and commercial work, crowded market, no phone |
| 7 | **San Diego County (unincorporated), CA** | Socrata `data.sandiegocounty.gov/resource/red2-qccu.json` + `4ju2-mf55` (contractors) + `wc68-2ej9` (contractor trades) | 2,657 | Daily (2026-11-12) | 87% permit; 99.6% contractor table | 87% | **No GC-sub view**: the contractor table holds one licensee per permit (0.2% of residential permits list 2+). CSLB licence number on 100% | 1986- | Not found. **Unread** | Excellent contacts and CA licence numbers, but no separate trade permits to link |
| 8 | **Cleveland, OH** | ArcGIS `services3.arcgis.com/dty2kHktVXHrqO8i/.../Building_Permits/FeatureServer/0` | 3,633 | Weekly-ish (edit 2026-11-08) | 0% | 91% (+ licence ID 91%) | `ASSOCIATED_PROJECT` links nothing (0%); parcel: E 15%, P 12%, M 7% | 2015- | Unread | Weak links. Skip for now |
| 9 | **Anaheim, CA** | ArcGIS `services3.arcgis.com/hPs600I3X0RTaaaq/.../Accela_Building_Permits/FeatureServer/0` | 899 | Daily (2026-11-12) | 80% | 80% | Trades in the same layer; `parcel` 99.9%. Link **not measured** | 1999- | Unread | Good contacts, small market |
| 10 | **Mesa, AZ** | Socrata `citydata.mesaaz.gov/resource/dzpk-hxfb.json` (the older `2gkz-7z4f` is retired) | 1,182 | Daily (2026-11-11) | 35% | 51% (+ licence 51%) | `parcel_number` 99.7%. Link **not measured** | 1987- | "See Terms of Use". Unread | Thin contact coverage |
| 11 | **Denver, CO** | ArcGIS `services1.arcgis.com/zdB7qR0BtYrg0Xpl/.../ODC_DEV_RESIDENTIALCONSTPERMIT_P/FeatureServer/316` (+ commercial `/317`) | 910 + 557 | Daily (2026-11-12) | 0% | 97-100% | **No trade permits** in these layers | 2011- | Attribution string only | GC list only, no sub view |
| 12 | **East Baton Rouge, LA** | Socrata `data.brla.gov/resource/7fq7-8j7r.json` | 1,997 | Daily (2026-11-07) | 0% | 100% | Trades in the same dataset; no parcel field seen. Link **not measured** | 2011- | Public Domain (metadata) | Small, clean licence |
| 13 | **Cincinnati, OH** | Socrata `data.cincinnati-oh.gov/resource/uhjb-xac9.json` | 2,507 | Daily (2026-11-10) | 0% | 99% | `pin` 98.6%. Link **not measured** | 2010- | Public Domain (metadata) | Small, clean licence |

Smaller sources that also work (verified fields, not ranked): Everett, WA
`data.everettwa.gov/3w3u-656c` (2,067 / 90 d, contractor 100%, no phone);
Marin County, CA `data.marincounty.gov/mkbn-caye` (1,123, contractor 99%);
Seattle trade permits `cos-data.seattle.gov/c87v-5hwh` and electrical
`c4tj-daue` (contractor 81-83%, text dates; building permits only 7%).

### Checked and not usable now

| Market | What was found (2026-11-13) |
| --- | --- |
| Dallas | `e7gq-4sah` is daily, but `contractor` is **empty on all 2,000 most recent rows**, and `issued_date` is text. This contradicts the older note above ("sometimes with phone"); the earlier rows may differ. Downgraded |
| Chicago | `ydr8-5enu`: no contractor company or phone in recent rows (contact slots only) |
| Phoenix | ShapePHX layer: no contractor field; `OWNER_NAME` only |
| Tempe, AZ | Contractor columns exist but are filled on about 2% of rows |
| San Antonio | CKAN `data.sanantonio.gov` "Building Permits": one free-text `PRIMARY CONTACT`, mixed with engineers and banner permits; weekly (modified 2026-11-08); CC BY |
| Wake County, NC | `CONTRACTOR` empty on recent rows |
| Boston | `6ddcd912-...`: `applicant` only (PDDL licence) |
| Nashville, Charlotte, Houston, Fort Worth, Jacksonville, Tampa, Atlanta, Las Vegas, Columbus, Indianapolis, Fort Lauderdale, Orange County FL, Hillsborough County FL, Sacramento, Scottsdale, Frisco, Plano, Cape Coral, Durham | No open building-permit dataset with contractor fields found by ArcGIS or Socrata search. This is "not found", not "does not exist": most of these run Accela, EnerGov or Tyler portals that would need scraping, which rule 4 and the terms of each portal must clear first. Houston publishes monthly counts only |
| CivicData.com (Accela's CKAN) | Many cities, but stale: Tampa, Charlotte, Cincinnati and Clearwater files end 2015-2023; the freshest are mid-2026 annual drops |
| Tallahassee / Leon County | Layer holds only currently active permits (1,398 rows), so no history |

### Licence and terms review (2026-11-13)

This is a reading of the published text, **not legal advice**. Item licences
were read from ArcGIS Online item metadata (`recon/market_terms.js`, Actions
run 43447100887). Website terms and statutes were read with a web fetch. Quotes
are verbatim.

| Source | What the text says | Status for a commercial B2B product |
| --- | --- | --- |
| City of Miami, `Building_Permits_Since_2014` | Item licence: "This work is licensed under a Creative Commons Attribution 4.0 International License". Credit line: "© 2019 City of Miami, Department of Innovation and Technology, GIS Team". The city's own terms and disclaimer pages did not load (the portal returns an empty JavaScript page and miami.gov/Copyright returned an error) | **Cleared for ingest and display, with attribution.** CC BY 4.0 allows commercial use. Show the credit line and a licence link wherever the data appears, and note any changes we make |
| Raleigh, `Building_Permits` and `Permits_Other_Than_Buildings` | Item licence: "Open Raleigh Data Policy". It disclaims warranties, says use is "at one's own risk", and says the City may "require the termination of any and all displaying, distributing or otherwise using any or all of the data for any reason". It incorporates the "City of Raleigh Open Data Privacy Policy", which was **not readable** (empty JavaScript page). No ban on commercial use or redistribution appears | **Cleared for ingest, with two open items.** (1) The City can order us to stop using the data at any time, so the connector must be easy to switch off and to purge. (2) The privacy policy it incorporates is unread |
| Philadelphia, `PERMITS` | Item licence: data "is provided “as is”", and the user "will hold the City of Philadelphia harmless from any and all claims" (indemnity). phila.gov Terms of Use: "Commercial use is prohibited without the prior written permission of the City." and "All rights are reserved." The OpenDataPhilly listing names a "City of Philadelphia License" that "reserves all rights in the database". The specific licence page (metadata.phila.gov) did not render | **Blocked.** The only terms we could read prohibit commercial use without written permission, and the item adds an indemnity. Do not build until the City grants written permission or a lawyer concludes the website terms do not apply to the open data |
| Miami-Dade County, `miamidade_permit_data`, ArcGIS item | Item licence is a disclaimer only: data is "as is" and "not guaranteed to be accurate, correct or complete". No licence grant or restriction | No restriction found; no explicit grant either |
| Austin, `3syk-w9eu` (already integrated) | Terms: `https://data.austintexas.gov/stories/s/City-of-Austin-Open-Data-Terms-of-Use/ranj-cccq/`, read 2026-11-13 through the Storyteller API (`/stories/api/v1/stories/ranj-cccq/published/latest`) because the page renders empty. "Data available through the City of Austin Open Data Portal are offered free and without restriction." "Unless otherwise noted in metadata, datasets ... are in the public domain". The terms incorporate the City of Austin Privacy Notice (not read). The no-warranty text says use is "at your own risk". Nothing on automated access appears in the part read (the first 6,000 characters; the text after "Confidentiality" was not read) | **Cleared**: public domain, so redistribution is allowed. Credit is not required; the dataset's attribution string "City of Austin, Texas - data.austintexas.gov" is a courtesy |
| Miami-Dade County, `miamidade_permit_data` (already integrated), website agreement | `https://www.miamidade.gov/global/disclaimer/disclaimer.page`, read 2026-11-13. The user agrees to use the site "as permitted by applicable local, state, and federal laws", and "taking action which results in blocking access to this website by other users will be deemed an unauthorized use". The user "expressly consents to administrative monitoring". "Any rights not expressly granted herein are reserved." No licence grant, and no clause on redistribution or commercial use. The open-data hub's own terms page (gis-mdc.opendata.arcgis.com/pages/terms-of-use) renders empty and was not read | **Unclear, for a lawyer.** Automated access is fine at polite rates (the agreement only bars blocking other users). Redistribution is neither granted nor prohibited. Florida ch. 119 makes the records public, but "rights ... reserved" leaves the question open. Keep a credit line ("Source: Miami-Dade County") |
| Orlando, `ryhf-m453` | No licence in the Socrata metadata; the portal's "Legal" page was not read | Not cleared: no terms read |

**Public records statutes (context only).** Florida ch. 119.01(1): records are
"open for personal inspection and copying by any person", subject (119.01(2)(d))
to "copyright and trade secret laws and public records exemptions"; no limit on
the purpose of use was found in 119.01 or 119.07. North Carolina G.S. 132-1:
"the people may obtain copies of their public records"; records "are the
property of the people"; no purpose limit. Neither statute replaces a portal's
licence or terms.

**For a lawyer.** These are open questions, not conclusions:

1. Whether the phila.gov website terms (no commercial use) govern the Philadelphia
   open-data layer, and whether the City would grant permission.
2. Outreach rules for contacting contractors found in the data: calls and texts
   to contractor phones (TCPA and the federal and state do-not-call rules, even
   for B2B numbers that may be mobiles), emails to the Raleigh contractor emails
   (CAN-SPAM, NC law), and Florida's telemarketing rules (FTSA). This product
   and its customers both make such contacts.
3. Raleigh's right to "require the termination" of our use: what notice we would
   get and what we would have to delete.
4. Philadelphia's indemnity clause, if Philadelphia is ever used.
5. Miami-Dade: whether redistributing the county permit layer in a paid product
   is allowed, given that the website agreement reserves all rights it does not
   grant and the hub's own terms are unreadable.
6. Texas ch. 302 registration (already flagged in `docs/COMPLIANCE.md`), and
   whether Florida or North Carolina have an equivalent for selling lead lists.

Rule 5 still applies everywhere: contractor names that look like individuals,
and owner names, stay hidden until the homeowner-track compliance gate passes.

### Recommended next 3

1. **City of Miami.** Cheapest to add and strengthens the pilot that already
   exists: daily instead of weekly, 7,815 permits per quarter, and the
   application number links building to electrical and plumbing permits at
   43-45% with a different company 87-99% of the time. Blocker to clear:
   no phone, so contact data has to come from the Miami-Dade layer
   (`ContractorPhone`, 82%) by licence or name match. That match rate is
   **not measured yet**.
2. **Raleigh.** The best contact data found outside Austin (76-86% phone,
   85-91% email) and the strongest GC-sub links measured anywhere (72-85% by
   parcel, a different company 97-98% of the time). Trade permits are issued
   the same day as the building permit, so the data shows relationships, not an
   early window. Volume is about a quarter of Austin's.
3. **Orlando**, now that Philadelphia is blocked by its terms (see the licence
   review). Orlando is the user's pick and has phones on half its rows, but its
   links are parcel-only and weaker (26-34%), and its terms have not been read
   yet. Philadelphia (51-67% links, most volume after NYC) needs the City's
   written permission first.

What would change this ranking: written permission from Philadelphia; the
City of Miami to county phone match rate; Orlando's terms; and the
expediter caveat from Austin (if one company pulls trade permits for many
GCs, "sub differs" overstates real subs).

## Enrichment sources (verified 2026-11-13)

From `recon/enrichment_sources.js`, run in GitHub Actions against the live
sources (runs 43446556469, 43447503570, 43448074851; re-run with the
`feasibility` workflow and `only=enrichment`). The script prints field names,
counts, fill rates, code values and ID shapes only (`A` = letter, `9` =
digit). Terms were read from the source's own pages on 2026-11-13 unless
marked **not reviewed**. Nothing here is integrated yet.

Summary:

| Source | Join key | Verdict |
| --- | --- | --- |
| TX TDLR All Licenses | No licence number on Austin permits, so phone or name | **Use** for electrical contractor phones. Useless for HVAC phones |
| TX TSBPE plumbing lists | No licence number on Austin permits, so company name or phone | **Use** for company names; phones only after the rule 5 review |
| FL DBPR construction and electrical | Miami-Dade `ContractorNumber` = DBPR licence number (95.9% of permits) | **Use**: licence status, class, business address. No phone |
| TCAD appraisal export | Austin `tcad_id` = TCAD `geo_id` (90.8%) | **Use**, internally only; needs a legal check before any derived value is shown |
| Miami-Dade PA Property Point View | `FolioNumber` = `FOLIO` (99%) | **Use**: property type, size, year built, value and coordinates |
| US Census batch geocoder | Address | **Use** to fill Austin's missing coordinates |

### Texas TDLR, All Licenses (`data.texas.gov` `7358-krk7`)

| Field | Value |
| --- | --- |
| Endpoint | `https://data.texas.gov/resource/7358-krk7.json` (SODA). Bulk: SODA pages of 50,000 (verified). The standard Socrata CSV export was not fetched |
| Reachable | From Actions, yes. Not from the dev container (proxy 403) |
| Columns | `license_type`, `license_subtype`, `license_number`, `license_expiration_date_mmddccyy` (`MM/DD/YYYY` text), `business_name`, `business_county`, `business_address_line1/2`, `business_city_state_zip`, `business_telephone`, `owner_name`, `owner_telephone`, `mailing_address_line1/2`, `mailing_address_city_state_zip`, `mailing_address_county`, `continuing_education_flag`, `business_mailing`, plus 8 Socrata computed-region columns |
| Volume | 966,778 rows, 92 `license_type` values |
| Freshness | `rowsUpdatedAt` 2026-10-19 (25 days old on 2026-11-13). No schedule stated. The attribution link is `tdlr.texas.gov/LicenseSearch/licfile.asp` |
| Junk rows | 6 rows whose `license_type` is report boilerplate from a Salesforce export ("Generated By: Public Information Act (PIA) 9/18/2026", a confidentiality notice, copyright lines). Filter on a known list of licence types |
| Licence number | Digits only (`99999` for electrical contractors), no prefix. Key on `(license_type, license_number)`, not the number alone |
| Terms | No licence field in the metadata. The data.texas.gov terms page was not found: **not reviewed** |

Trade-relevant types:

| `license_type` | Rows | `business_telephone` | Business address | Business vs individual |
| --- | --- | --- | --- | --- |
| Electrical Contractor (`EC`) | 14,031 | **100%** | 99.9% | `business_name` = `owner_name` on every row, and 94.9% look like a business (legal suffix or trade word). `owner_telephone` = `business_telephone` on 14,025. So the "owner" fields repeat the business; there is no individual on these rows |
| Electrical Sign Contractor | 652 | 100% | 100% | Same pattern (69% business-like) |
| A/C Contractor (subtypes `BE`, `AC`, `AE`, `BC`, `AR`, `BR`, ...) | 20,462 | **0%** | **0%** | `business_name` 98% filled, 81% business-like. `owner_name` is the individual licensee (0% business-like). No phone or address at all |
| Master / Journeyman / Apprentice Electrician, A/C Technician | 19,920 / 45,391 / 283,425 / 61,248 | 0% | 0% | Individuals. `business_name` holds the person's name. Not useful for leads; rule 5 applies |

Join test against Austin trade permits issued in the last 90 days (Austin has
no licence-number column, so the join is by phone or normalized name):

| Austin permits | Phone found among TDLR electrical and A/C business phones | Distinct companies whose normalized name is a TDLR `business_name` |
| --- | --- | --- |
| EP (electrical) | 59.8% of 4,404 | 85.4% of 642 |
| MP (mechanical) | 10.2% of 2,896 | 73.6% of 417 |

**Recommendation: use** for electrical: a licensed-business check and a
second phone. For HVAC it confirms the business name only. The permit's own
phone stays the primary contact. `owner_name` on A/C rows is an individual:
store, never display (rule 5).

### Texas plumbing licences (TSBPE "Free Licensee List")

| Field | Value |
| --- | --- |
| Page | `https://tsbpe.texas.gov/free-licensee-list/` |
| Files | CSV with a header row. Responsible Master Plumber `https://tsbpe.texas.gov/download-csv/RMP/`, Master Plumber `.../download-csv/MP/`, Tradesman `.../TP/`, Inspectors `.../PI/`. Journeyman and Apprentice are static `.csv.zip` files under `wp-content/uploads/2015/03/` |
| Reachable | From Actions, yes |
| Freshness | "Tables are updated daily", current as of the previous work day. Files fetched 2026-11-13 had `Last-Modified` 2026-11-13 |
| RMP columns | `RANK`, `LICENSE_NBR`, `LIC_STATUS` (`Current` 8,702 / `Expired` 723), `LICENSE_DATE`, `EXPIRATION_DTE`, `LAST_NAME`, `FIRST_NAME`, `MIDDLE_NAME`, `SUFFIX`, `ADDR1-3`, `CITY`, `STATE`, `ZIP`, `PHONE`, `COUNTY`, `MEDGAS_ENDR`, `MRF_ENDR`, `WS_ENDR`, `INS_EXPIRY_DTE`, `PLUMB_COMPANY`, `INSURANCE_COMPANY` |
| RMP volume and fill | 9,425 rows. `PLUMB_COMPANY` 99.9% (8,557 distinct companies), `PHONE` 50.3% (10 digits), address 51.2%, `COUNTY` 99.8% (Travis 281) |
| MP columns | Same minus address, phone and company: names, `ZIP`, `COUNTY`, endorsements. 4,368 rows. Not useful |
| Business vs individual | Each row is a **person** (the responsible master plumber) with the "last known company" in `PLUMB_COMPANY`. Whether `PHONE` is the business or the person is not stated |
| Licence number | `LICENSE_NBR`. Austin permits carry no licence number |
| Terms | Page read: the Board "makes no guarantees" on timeliness or accuracy and corrects reported errors. No restriction on use or solicitation is stated |

Join test, Austin PP (plumbing) permits issued in the last 90 days: phone found
in RMP `PHONE` for 31.8% of 3,016 permits; normalized company name found in
`PLUMB_COMPANY` for 76.2% of 520 distinct companies.

**Recommendation: use** for company-to-licensed-plumber confirmation and
licence status. Treat `PHONE` as an individual's contact (rule 5) until the
compliance review says otherwise. Do not display licensee names.

### Florida DBPR, construction and electrical licence extracts

| Field | Value |
| --- | --- |
| Files | `https://www2.myfloridalicense.com/sto/file_download/extracts//CONSTRUCTIONLICENSE_1.csv` (47.1 MB; the double slash is in DBPR's own link) and `https://www2.myfloridalicense.com/sto/file_download/extracts/lic08el.csv` (4.0 MB) |
| Reachable | From Actions, yes |
| Format | Quote/comma ASCII, **no header row**, 22 fields per row (the published layout lists 21; the 22nd is always empty). Layout: board, occupation code, licensee name, DBA, class code, address 1-3, city, state, ZIP, county code, licence number, primary status, secondary status, original licensure date, effective date, expiration date, blank, renewal period, alternate licence number |
| Volume | Construction 263,512 rows (board `06`); electrical 19,886 (board `08`) |
| Freshness | ReadMe: "data is refreshed weekly". Both files had `Last-Modified` 2026-11-13 |
| Phone | **None** (confirmed). DBA filled 49% (construction) and 86% (electrical) |
| Occupation codes | Construction: `QB` 128,951, `CGC` 36,236, `FRO` 19,587, `CBC` 18,124, `CAC` 11,714, `CCC` 10,520, `CFC` 8,950, `CRC` 7,645, ... (29 codes). Electrical: `EC` 12,532, `ES`, `ER`, `EF`, `CRS3`, `EG`, ... (14). Codes are listed as found; their meanings are to be taken from DBPR, not guessed |
| Status | Primary status `C` (construction 263,091; electrical 19,730), `P`, `S`. Secondary status `A` / `I` (46% filled in construction, 92% in electrical). Codes to decode from DBPR. The ReadMe says null-and-void, delinquent and involuntarily inactive records are excluded |
| Licence number | Field 13 is digits only (51% filled in construction, mostly 7 digits). Field 21, the alternate licence number, carries the prefixed form (`AAA9999999`, `AA99999999`, ...) that permits use |
| Terms | ReadMe/Disclaimer and Disclaimer pages read: free download, no technical support, no liability. No restriction on commercial use or solicitation is stated. Florida says e-mail addresses are public records; these files carry none |

Join test: 10,000 Miami-Dade permits issued in the last 180 days, 8,307 with a
`ContractorNumber` (3,221 distinct). Exact match against fields 13 or 21: 91.6%
of permits. After normalizing (prefix plus number without leading zeros, so
`CGC061097` meets `CGC61097`): **95.9% of permits, 95.3% of distinct
numbers**. By shape: `AAA9+` 97.5% of 6,020, `AA9+` 98.7% of 1,748, `99A9+` and
`99AA9+` 100%, digits-only 0% of 141. Matched permits by occupation: `CGC`
2,572, `CCC` 1,597, `EC` 1,495, `CFC` 644, `CAC` 506, `CMC` 230, `CPC` 222.

**Recommendation: use** for licence status, class and the registered business
address, keyed on the normalized alternate licence number. It gives no phone.

### Travis Central Appraisal District (TCAD) appraisal export

| Field | Value |
| --- | --- |
| Page | `https://traviscad.org/publicinformation`, "Publicly Available Data" |
| Files | 2026 Supplemental Appraisal Roll Export (legacy fixed-width, 510.5 MB zip, 17.8 GB unzipped, `Last-Modified` 2026-11-10); 2026 Certified Appraisal Export (557.2 MB, 2026-07-22); JSON "Special" exports (3.5-3.6 GB each, not opened); Export Layout zip (PDF and XLSX, "Legacy 8.0.33", 2026-06-02) |
| Reachable | From Actions, yes (510 MB in 3-6 s) |
| Freshness | Certified roll yearly (July); supplemental files re-posted as the roll changes (the current one is "SUPP 336"). No schedule stated |
| Main file | `PROP.TXT`: 493,463 rows, record length 9,922, all `prop_val_yr` 2026. `prop_type_cd`: `R` 442,089, `P` 39,630, `MH` 11,739, `MN` 5 |
| Key | `geo_id` (positions 547-596, 92.7% filled, mostly 10 digits) **is Austin's `tcad_id`**: 90.8% of the 7,974 distinct `tcad_id` values on Austin permits from the last 90 days match. 265 Austin values are letter plus digits; 65 of them match `prop_id` once the letter is dropped. 91.6% match in total. Austin's `tcad_id` is 99.5% filled. `prop_id` (positions 1-12, zero-padded) is TCAD's internal id |
| Property type | `imprv_state_cd` (2732-2741) and `land_state_cd` (2742-2751), Texas state property codes. Top: `A1` 289,851, blank 92,156, `A4` 54,564, `F1` 12,127, `M1` 11,677, `B2` 9,684, `A2` 5,810 |
| Value | `market_value` (4214-4227) and `appraised_val` (1916-1930), both 100% filled |
| Year built, area | `IMP_DET.TXT` (3,310,108 rows, record length 622; 400,973 properties): `yr_built` (86-89) 98% filled (sample p5/p50/p95 1954/2000/2023), `imprv_det_area` (94-108) 99.6%, typed by `imprv_det_type_cd` (`1ST` 1st Floor, `2ND` 2nd Floor, `011` open porch, `041` attached garage, `251` bathroom, `252` bedrooms, `095` residential HVAC, `604` pool, ...). Living area is therefore the sum of the floor-type rows: a derivation to validate, not a field |
| Owner | `py_owner_name` 100% filled. Stored only if needed, never displayed (rule 5). `py_confidential_flag` (position 990) is `T` on 0 rows: confidential owners appear to be withheld from the public file (not verified) |
| Other | Situs address (99.6%), legal description, deed book and date, exemptions in `PROP_ENT.TXT` (9.8 GB) |
| Terms | No terms of use, licence or redistribution clause on the public-information page, the open-government page or the privacy policy (all read 2026-11-13). Other records by Public Information Act request. **Needs a legal check** before showing derived values: appraisal data is public, but no reuse terms are stated |

**Recommendation: use** for property type, size, year built and value on
Austin leads, joined on `geo_id`. Load the supplemental export on a schedule
(weekly `Last-Modified` check), parse only the needed columns, and never
display owner names.

**Built (2026-11-13):** `ingest/enrich_tcad.js`, daily. It finds the newest
supplemental export link on the public-information page (falling back to the
SUPP 336 link) and stores only parcels named by Austin permits. Living area is
the sum of the main improvement's floor rows (`1ST`, `2ND`, ...). Year built is
the earliest year among those floors. The flags it skips on are at positions
990, 991, 2569, 2570, 4859 and 4860 (layout read 2026-11-13).

### Miami-Dade Property Appraiser, Property Point View

| Field | Value |
| --- | --- |
| Endpoint | `https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/PaGISView_gdb/FeatureServer/0` (ArcGIS item `bf92e51f90a8426cae904ebc15018067`, owner `MDPublisher`) |
| Reachable | From Actions, yes |
| Type | Point feature layer, `maxRecordCount` 2000 |
| Volume | 944,398 rows |
| Freshness | Item description: "updated weekly on Saturdays". `lastEditDate` 2026-11-12 |
| Key | `FOLIO` (13 digits, 99.4% filled). **99% (396 of 400) of distinct permit `FolioNumber` values from the last 90 days match** |
| Fields | `FOLIO`, `X_COORD`, `Y_COORD`, `TRUE_SITE_ADDR_NO_UNIT`, `TRUE_SITE_UNIT`, `TRUE_SITE_CITY`, `TRUE_SITE_ZIP_CODE`, mailing address, `TRUE_OWNER1-3`, `CONDO_FLAG`, `DOR_CODE_CUR`, `DOR_DESC`, `SUBDIVISION`, `BEDROOM_COUNT`, `BATHROOM_COUNT`, `HALF_BATHROOM_COUNT`, `FLOOR_COUNT`, `UNIT_COUNT`, `BUILDING_ACTUAL_AREA`, `BUILDING_HEATED_AREA`, `LOT_SIZE`, `YEAR_BUILT`, `ASSESSMENT_YEAR_CUR`, `ASSESSED_VAL_CUR`, `DOS_1`, `PRICE_1`, `DATEOFSALE_UTC` |
| Fill | `DOR_CODE_CUR` 99.4%, `BUILDING_HEATED_AREA` 91.9%, `YEAR_BUILT` 92%, `ASSESSED_VAL_CUR` 98%, `BEDROOM_COUNT` 84.4%, `UNIT_COUNT` 80.4%, `FLOOR_COUNT` 55.2%, `LOT_SIZE` 61%, `TRUE_SITE_ZIP_CODE` 99.3%, `TRUE_OWNER1` 99.3% |
| Land use | `DOR_CODE_CUR` top: `0407` 323,474, `0101` 319,505, `0410` 66,006, `0105` 42,920, `0802` 23,720. Decode with `DOR_DESC` |
| Value | Assessed value only; no market value field |
| Bonus | It gives the permit layer a ZIP (missing there) and coordinates via the folio. The spatial reference of `X_COORD` and `Y_COORD` is not yet recorded |
| Owner | `TRUE_OWNER1-3`: never fetched for display (rule 5); leave them out of `outFields` |
| Terms | Item `licenseInfo` read: provided "as is", approximate, "for illustration only", not for site-specific decisions; no redistribution restriction stated. The open-data hub terms page was **not reviewed** (the hub page rendered no terms). The Property Appraiser's paid bulk files (`bbs.miamidadepa.gov`, $50 per file, weekly CSV, account required) were not used |

**Recommendation: use**, joined on folio, through the public layer (no paid
files).

### US Census Geocoder, batch

| Field | Value |
| --- | --- |
| Endpoint | `https://geocoding.geo.census.gov/geocoder/locations/addressbatch` (also `geographies/addressbatch`, which adds state, county, tract and block). Multipart form: `addressFile`, `benchmark` (and `vintage` for geographies) |
| Input | CSV `Unique ID, Street address, City, State, ZIP`, no header |
| Limit | "Upper limit of 10,000 records per batch file" (API PDF). No rate limit stated |
| Benchmarks (live) | `4` Public_AR_Current, `8` Public_AR_ACS2026, `11` Public_AR_LUCA, `2020` Public_AR_Census2020 |
| Live test | 50 Austin permit addresses from the last 90 days: 36 exact, 5 non-exact, 9 no match (82% matched), answered in about 1 s |
| Reachable | From Actions, yes |
| Terms | No terms of service on the documentation page or in the API PDF (both read). A US federal service. **Not reviewed** beyond that |

**Recommendation: use**, as a batch step at ingest (never at request time),
only where the source has no coordinates, and record the match type as
provenance.

**Built (2026-11-13):** `ingest/geocode.js`, daily after parcels. Order:
source coordinates, then the appraiser parcel point, then the Census on the
permit's job-site address (a leading house number plus a ZIP or city).
Answers are cached in `geocode_cache`; misses and ties are asked again after
30 days; at most 20,000 new addresses per run, 2,000 per request. Results are
in `permit_locations` with `method` and `quality`, and the job API returns
them as `location` with the Census notice as attribution.

### Coordinates already in the permit sources

- **Austin `3syk-w9eu`:** has `latitude`, `longitude` (number) and `location`
  (point). Filled on 84.4% of all 2,385,260 rows but only **60.6% of the
  14,816 permits issued in the last 90 days** (EP 61.8%, PP 58%, BP 63.5%,
  MP 61.5%, DS 39.4%). Range 30.11 to 30.51 N, -97.999 to -97.551 W, which is
  Austin. Recent permits seem to get coordinates later (to confirm with the M2
  snapshots). There is also a text `permit_location`. Fill the gap from the
  Census geocoder.
- **Miami-Dade permit layer:** a `Table` with no geometry and no coordinate
  fields. Coordinates come from the Property Appraiser layer through
  `FolioNumber`.

## Connectors built, not yet enabled (2026-11-13)

Fields read live from GitHub Actions with `recon/capture_fixture.js --layer`
(runs 43449338813, 43449344268, 43449348906); fixtures in
`test/fixtures/sources/`. Both are `enabled = false` until a trial backfill
passes the health check.

### City of Miami, FL (`miami-city-fl`)

| | |
| --- | --- |
| Endpoint | `https://services1.arcgis.com/CvuPhqcTQpZPT9qY/arcgis/rest/services/Building_Permits_Since_2014/FeatureServer/0` |
| Freshness | Layer edited 2026-11-13 (daily) |
| Contractor | `CompanyName`, `CompanyAddress`, `CompanyCity` (97% of the 60 newest). **No phone** |
| Job link | `ApplicationNumber`; the type is the letters before the last 3 digits of `PermitNumber` (B building, E electrical, P/PG plumbing, ME mechanical). Unmapped codes seen: ZS, SE, MA, PW |
| Parcel | `FolioNumber` (12 digits as a number; the county uses 13-digit folios, so the join needs a leading zero check) |
| Coordinates | `Latitude`, `Longitude` (100%) |
| Terms | CC BY 4.0 (item licence). Credit line stored as the sources row's `attribution_text` |

### Raleigh, NC (`raleigh-nc`)

| | |
| --- | --- |
| Endpoints | `.../v400IkDOw1ad7Yad/arcgis/rest/services/Building_Permits/FeatureServer/0` and `.../Permits_Other_Than_Buildings/FeatureServer/0`, read as one source |
| Freshness | Both edited 2026-11-13 |
| Contractor | `contractorcompanyname` (93% building, 100% trade), `contractorphone` (78% / 95%), `contractoremail` (stored, not shown), `contractortype`. `contractorlicnum` is empty |
| Job link | Parcel `pin`. Trade from `permittype` text ("DSINSP - Electrical (Residential)") |
| Owner | `parcelownername` (stored, never shown: rule 5) |
| Coordinates | `latitude_perm`, `longitude_perm` on the building layer only |
| Terms | Open Raleigh Data Policy: the City may require us to stop. Switch-off and purge steps in `docs/CONNECTORS.md` |
| Sync windows (E2, read 2026-11-13) | Building: `applieddate` 30d. Trade: `CreationDate` 30d, because the trade layer has no `applieddate`. Both layers: `issueddate` 30d and `recordupdatedate` 14d. `EditDate` moves about 1,000 trade rows a day, so it is not used. One live adapter run returned 6,855 rows in 22 requests, not truncated |
| Pre-issue share | Building filings applied in the last 30 days: 335 of 459 not issued. Trade filings created in the last 30 days: 1,028 of 2,406 not issued, most of them `Ready for Issuance`. Each has a `permitnum` |
| Filing date | `filedDate` is `applieddate` on the building layer and `issueddate` on the trade layer. An unissued trade filing has no published date, so it stays NULL (1,101 of 6,855 in the live run) |

## Explicitly excluded

- **Washington County, OR:** CAPTCHA-gated. Do not automate. The legitimate
  path is a bulk-data request.
- **Portland, OR CSV:** columns never verified; disabled.
- **Clackamas County and Oregon statewide (Accela):** working, but out of the
  pilot (ADR-5).

## Pre-approval scan (2026-11-13)

Goal (ADR-16): find where construction is publicly visible **before** a
permit is issued, at what stage, how fast, with which participants, and
whether it links to the eventual permit.

**Method.** Live calls from GitHub Actions on 2026-11-13 with
`recon/preapproval_scan.js` (`feasibility` workflow, input `preapproval`;
runs 43482027220 discovery and probes, 43482672491 indirect signals,
43484084787 and 43485134480 explicit probes, 43485700776, 43485934262,
43486065480 and 43486183299 SoQL checks and the Austin link). Discovery swept the Socrata
catalog (337 candidate datasets) and ArcGIS Online (115 + 251 services); 117 +
55 + 22 datasets were probed. Each probe reads the status column, the
application and issue dates, and the participant columns of the 500 newest
rows.

- **Pre-issue share** = of filings applied in the last 30 days, the share with
  no issue date yet. A dataset that only holds issued permits scores 0%.
- **Rows by application day** for the last 21 days is a publication-lag
  proxy: if yesterday's and today's rows are already near a normal day's
  volume, the lag is about a day or less. It is **not** a measured lag; that
  needs the 14-day snapshot (ARCHITECTURE section 19.2).
- **Verified** = read from the live API as described. **Unverified** = not
  measured, or read only from a web page.

### What our four live markets expose before approval

| Market | Pre-approval source | Verified | Stage first visible | Speed | Participants at that stage | Updates | Links to the issued permit | History | Terms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Austin, TX** | **Plan Review Cases** `datahub.austintexas.gov` `n8ck-xkda` (162,827 rows) | Yes | Intake: statuses `Pending`, `Application Incomplete`, `Intake Pending`, `In Review`, `Awaiting Update`, `Prerequisite Review Approved`, `Approved` | 8 cases applied 2026-11-13 were already published that afternoon; `status_date` values from 10:04 the same morning; `update_date` max 12:18 the same day. **Intra-day publication**, lag not yet measured | `applicant_full_name` 93%, `applicant_organization_name` 62%, `owner_*` 0-11%; **no contractor** at this stage. Applicant orgs mix builders (Meritage, KB Home, Brookfield) and **permit expediters** (Austin Permit Service, Austin Express Permits, Permit Solutions, KS Permitting) | `status_current` + `status_date` | **Official key:** the issued BP's `masterpermitnum` equals the plan-review `folderrsn` (3 of 3 checked, plus 1 found in reverse), same `appraisal_id` = `tcad_id`, same applied date. 97.6% of BPs issued since 2026-08-01 carry `masterpermitnum`. Link rate not measured at scale | 2014- | Public Domain (dataset metadata) |
| Austin, TX | Issued Construction Permits `3syk-w9eu` (what we ingest) | Yes | Issued only: 0% pre-issue (0 of 2,089) | 2-3 days after issue (M1) | Contractor company 91% | Status after issue | n/a | 1921- | Public Domain |
| Austin, TX | Site Plan Cases `mavg-96ck`, Subdivision Cases `s7gx-9m54`, Zoning Cases `edir-dcnf`, Board of Adjustment `ykxk-t5y9` | Yes (first three probed) | Pre-application: `Intake Pending`, `In Review`, `Awaiting Update`, `Scheduled for Hearing` | Rows applied the previous day present; updated daily | Site plans: applicant org 88%, owner org 48%; zoning: applicant org 58%; proposed units, building sq ft, `tcad_id` | Status + status date | Parcel (`tcad_id`) and `related_cases`, not a permit key | 1971-/1981- | Public Domain |
| Austin, TX | Legistar `austintexas` | Yes | Council and committee agendas; matter types "Zoning and Neighborhood Plan Amendments" | 23 events in 45 days, 18 with agendas | Case numbers in titles (not parsed yet) | n/a | Case number | n/a | No API terms published (Granicus docs) |
| **Raleigh, NC** | Building Permits layer we already ingest (`services.arcgis.com/v400IkDOw1ad7Yad/.../Building_Permits/FeatureServer/0`) | Yes | **Submitted**: 72.5% of last-30-day applications not issued; statuses `Submitted - Online`, `Submitted`, `In Review`, `Ready for Issuance`, `Delayed Issuance`, `On Hold` | Rows applied 2 days earlier at near-normal volume | **Contractor company 74%** at application; parcel owner 67% (hidden, rule 5) | `statuscurrent` | Same record (`permitnum`) | 2000- | Open Raleigh Data Policy (may order us to stop) |
| Raleigh, NC | Permits Other Than Buildings (trade layer we ingest) | Yes | 42.7% of last-30-day trade filings not issued; `Ready for Issuance` 1,711 in 90 days | Same day (28 rows created 2026-11-13) | Contractor company 96%, phone and email in the layer | `statuscurrent` | `pin` and same record | 2018- | Same |
| Raleigh, NC | ROW occupancy permits | Yes | 30.5% pre-issue | Daily | `company_name` 86% | Status | `pin_number` | 2017- | Same |
| Raleigh, NC | Planning agendas | Yes (negative) | Not on Legistar (client returns "not set up"); the city moved to eScribe on 2025-07-01 (raleighnc.gov notice) | | | | | | |
| **City of Miami, FL** | `Building_Permits_Since_2014` (what we ingest) | Yes | Issued only: 0% pre-issue (0 of 856); statuses `Active`, `Final`, `Revoked`, `Hold` | Daily | Company 99% | Status | n/a | 2012- | CC BY 4.0 |
| City of Miami, FL | Tree Permits layer | Yes | Review stage: `Intended decision`, `Corrections Required`, `Approved` | Daily | Plan number and address only, **no names** | Review status date | Plan number | 2017- | Unread |
| City of Miami, FL | Legistar `miamifl` | Yes | API answers, but **0 events in 45 days**: not used for current agendas | | | | | | |
| **Miami-Dade, FL** | County permit layer (what we ingest) | Yes | Issued only: 0% pre-issue (0 of 2,761) | Weekly | Contractor 100%, **architect 100%**, owner 99.6% | n/a | Master permit | 2008- | Disclaimer only |
| Miami-Dade, FL | Certificate of Occupancy daily layer `certif_of_occupancy_daily_data` | Yes | After construction (CO) | Daily-ish (latest 2026-11-06) | Owner 89% (hidden), permit-holder number | n/a | `PERMIT_NUMBER`, `FOLIO` | 2002- | Unread |
| Miami-Dade, FL | Land Management Hearing view, Permits Requiring Allocation | Found, **not probed** | Hearings (zoning) | | | | | | |
| Miami-Dade, FL | Legistar `miamidade` | Yes (negative) | API answers, latest matter 2018: not used | | | | | | |

**Answer for the pilot markets:** Austin and Raleigh **do** publish
applications before approval through official APIs; City of Miami and the
Miami-Dade county layer do **not** (issued permits only). Raleigh's
pre-approval rows are in layers we already pull, but our connector windows on
`issueddate`, so we drop them (and maps `filedDate` to `issueddate`). Austin's
are in a separate dataset we have never read.

### Strong candidates outside the pilot

| Market | Dataset | Pre-issue share (30 d) | Stage vocabulary seen (90 d) | Participants | Speed proxy | Terms |
| --- | --- | --- | --- | --- | --- | --- |
| New York City | DOB NOW: Build Job Application Filings `w9ak-ipjd` (38,990 filings in 90 d) | Lifecycle in one row (no issue column) | `Pending Plan Examiner Assignment`, `Plan Examiner Review`, `Objections`, `Approved`, `Permit Entire`, `Incomplete` | Applicant professional with licence 100%, applicant business 100%, owner business 95%, filing representative business 78% | Filings dated 2026-11-12 present | Unread (NYC.gov "all rights reserved"; portal terms page did not load in the earlier scan) |
| New York City | DOB NOW electrical `dm9a-ab7w`, elevator `kfp4-dz4h`, LPC applications `dpm2-m9mq` | 18.6% (electrical) | `Pending Payment Verification`, `Approved` | Firm name and number 100% | Daily | Unread |
| Orlando, FL | Permit Applications `ryhf-m453` | 56% | `Open`, `Hold`, `Finaled` (coarse) | Contractor 85%; owner (hidden) | 11 rows on the day of the scan | Unread |
| Orlando, FL | Planning Applications `bhxy-4rji`; ROW use permits `6sbc-v4b9` | n/a; 81% | `Open`, `Approved` | Applicant 99.7%; ROW contractor 87% | Daily | Unread |
| New Orleans, LA | Permits - BLDS `72f9-bi28`; `aib5-en5t` | 47-53% | `Application Submitted`, `Application Review`, `Zoning Review`, `Plan Review`, `Information Needed`, `Permit Approved` | Contractor company 70%, licence 46% | Daily | **CC0** |
| Seattle, WA | Building Permits `76t5-zqzr`; Permit Review Time `crg2-ssqd`; Land Use Permits `ht3q-kdvx` | 72% | `Application Completed`, `Reviews In Process`, `Corrections Required`, `Ready for Issuance` | **Contractor 0.8%**: no participants | 1-2 days | Public Domain |
| Norfolk, VA | Permits `fahm-yuh4` | 37% | `Portal Submitted`, `Reviews in progress`, `Additional Information Required` | none in probed columns | Daily | Unread |
| Nashville, TN | Building Permit Applications layer (6,033 rows); Development Tracker cases | Unverified (the application date is a text field the probe could not read) | | `Contact` free text | Updated 2026-11-13 | Unread |
| San Francisco, CA | DBI Building Permits `i98e-djp9` | **Unverified**: the API answered HTTP 428 (likely needs an app token now) | | | | |
| Los Angeles, Chicago, Montgomery County MD, Cambridge MA, Baton Rouge | | 0% (issued only) | | | | |

### Pre-Approval Data Availability Score (PADAS)

A 0-100 score per market, from the measurements above. It is a planning tool,
not a fact: each part says what it rests on.

| Part | Points | Full marks when |
| --- | --- | --- |
| Earliest visible stage | 30 | Submitted applications (25) plus a pre-application feed (planning, site plan, zoning) (+5) |
| Publication speed | 20 | Same-day or next-day rows observed (a measured lag later replaces the proxy) |
| Participants at that stage | 20 | A business that subs sell to (GC or builder) is named at application stage; applicant-only 12; none 0 |
| Lifecycle tracking and link | 10 | Status + status date, and an official key to the issued permit |
| Access | 10 | Official API or bulk file (10); portal only (2) |
| Reuse terms | 10 | Open licence (10); unread (4); restrictive (0) |

| Market | Stage | Speed | Participants | Lifecycle | Access | Terms | **PADAS** | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Austin | 30 | 18 | 12 | 9 | 10 | 10 | **89** | Applicant, not contractor; expediters inflate "applicant"; link via `masterpermitnum` |
| New Orleans | 25 | 18 | 16 | 10 | 10 | 10 | **89** | Contractor 70% at application; CC0; no phone |
| Orlando | 30 | 18 | 18 | 7 | 10 | 4 | **87** | Coarse status; terms unread |
| New York City | 25 | 18 | 20 | 10 | 10 | 4 | **87** | Best participants (licensed professionals, owner businesses); crowded; terms unread |
| Raleigh | 25 | 17 | 18 | 9 | 10 | 6 | **85** | Contractor at application; city may order us to stop; no planning feed |
| Seattle | 30 | 17 | 2 | 10 | 10 | 10 | **79** | Great lifecycle, no names |
| Norfolk | 25 | 18 | 0 | 8 | 10 | 4 | 65 | |
| City of Miami | 0 | 18 | 0 | 3 | 10 | 10 | **41** | Issued only |
| Miami-Dade | 0 | 8 | 0 | 3 | 10 | 4 | **25** | Issued only, weekly; NOC route below |

### Indirect and hard-to-find signals

Ranked by early-signal value x uniqueness x feasibility (each 1-3; product
shown). "Uniqueness" is whether the big platforms are known to aggregate it;
"unknown" scores 2, not 3, because we have not verified that they lack it.

| # | Signal | Lead time vs. building permit | Fields (company names) | Access | Terms | Known users | Value x Unique x Feasible | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **Austin Plan Review Cases** (`n8ck-xkda`) | The plan-review period itself (residential median 63 d, p90 300) | Applicant org, valuation, units, floors, sq ft | Open API | Public Domain | Unknown | 3 x 2 x 3 = **18** | Verified (above) |
| 2 | **Raleigh pre-issue rows** in the layers we ingest | Review period | Contractor company 74-96%, phone, email | Open API, already connected | Open Raleigh policy | Unknown | 3 x 2 x 3 = **18** | Verified; connector change needed |
| 3 | **Austin site plan / subdivision / zoning cases** | Months before building filings | Applicant org 58-88%, owner org, proposed units, sq ft | Open API | Public Domain | Dodge/ConstructConnect cover planning stage for commercial (their pages) | 3 x 1 x 3 = 9 | Verified |
| 4 | **TDLR TABS project registrations** (TX, $50k+ commercial and public) | Before construction; often before the permit | Owner, design firm, RAS, estimated cost, start date, sq ft (project page) | Public search and per-project pages; **no open dataset found**; robots.txt disallows only `/ithelp/` and `*.csv` | No automation clause found on the pages read | Zabalist republishes TABS monthly (its methodology page) | 3 x 2 x 2 = **12** | Fields verified on one project page by web fetch; access method needs a terms decision before any automated read |
| 5 | **TABC pending original applications** `mxm5-tdpj` | Before a bar or restaurant opens; build-out timing unverified | Trade name, owner (business or person), address, licence type | Open API, current to the prior midnight | Unread | Unknown | 2 x 3 x 3 = **18** | Verified: 817 pending statewide, ~30 per weekday, Travis 49, Austin 40 |
| 6 | **Florida Notices of Commencement** (F.S. 713.13) | Recorded before the first inspection; void if work doesn't start in 90 days | Owner, contractor, surety, **lender**, folio | Miami-Dade Clerk bulk Official Records: $110 per folder per month, API $0.20 per request (clerk page); registration agreement unread | Unread | Unknown | 2 x 3 x 2 = **12** | Pricing verified by web fetch; NOC document-type code in the bulk layout unverified |
| 7 | Orlando / Raleigh ROW and use permits | Weeks before or alongside site work | Contractor 86-87% | Open API | Unread / Open Raleigh | Unknown | 2 x 2 x 3 = 12 | Verified |
| 8 | Legistar agendas (Austin) | Weeks to months | Case numbers, applicants in attachments (PDF) | Open API, no token for `austintexas` | No API terms published | Shovels is moving into planning-commission signals (Sacra summary) | 2 x 1 x 3 = 6 | Verified |
| 9 | Austin Water engineered tap plans | Before the building permit (no permit until tap fees are paid) | PE firm | AB+C portal only; a PIA request otherwise | n/a | Unknown | 2 x 3 x 1 = 6 | Process verified by web fetch; no dataset |
| 10 | TCEQ construction stormwater NOIs (TXR150000) | Before grading | Operator (often the GC) | **Not in the open dataset**: `6pm5-am5m` holds industrial (`TXR05...`, program `SWD`) and other general permits, no `TXR15` rows; construction NOIs are only in TCEQ's search tools | Unread | Unknown | 3 x 2 x 1 = 6 | Verified negative for the dataset |
| 11 | Miami-Dade certificates of occupancy | After construction | Permit holder number | Open API | Unread | Unknown | 1 x 2 x 3 = 6 | Verified (history value, not early) |
| 12 | Public procurement (SAM.gov API, Austin Finance Online, Miami-Dade solicitations) | Weeks before award | Agency, scope; awardees after award | SAM.gov API needs a key; city pages have no export found; Texas ESBD robots.txt refused our fetcher | Varies | ConstructConnect and Dodge cover public bids | 2 x 1 x 2 = 4 | Partly verified by web fetch |
| 13 | Tree permits (Austin, City of Miami) | Before or with site work | City of Miami: no names; Austin's layer is issued-only | Open API | Unread | Unknown | 1 x 2 x 3 = 6 | Verified |
| 14 | Public Information Act / Ch. 119 bulk requests for application data | Whatever the portal hides | As released | Lawful requests; Texas cannot ask why; costs estimated over $40 | Statutes don't bar reuse (unverified) | n/a | 2 x 3 x 1 = 6 | Process verified by web fetch |

Not available as open data: Austin Energy service applications and FPL
(no public data found); the Austin AMANDA ROW layer requires a token (HTTP
499), so it is off.

### Competitor coverage (read 2026-11-13, their own pages; not measured)

| Platform | Pre-approval / planning stage | Freshness claims | History and relationships | Contacts | Source |
| --- | --- | --- | --- | --- | --- |
| **Dodge** | Yes: "Pre-Design" stage ("has not yet advanced to design"), Design, Bidding. Pre-design records "updated every 8 months"; bidding weekly. Building-permit-derived projects get the stage "Permit" | Stage-based update cycles | Company profiles | Not stated | construction.com help center, "Dodge project action stages" |
| **ConstructConnect** | Yes: "conceptual, design, final planning, bidding, and post-bid"; lists "Permit Filing" 3-9 months before bid; sources include "permit filings, planning commission records, developer announcements" | "Project Intelligence is updated daily"; "400+ researchers"; "one million verification calls annually" | 575,000 company records | Owner contact information on early records; alerts by trade and geography | constructconnect.com blog (2026-08-13) and "about project intelligence" |
| **Shovels** | Moving into "earlier signals than building permits": rezoning applications, planning-commission votes (Sacra summary, paywalled) | First-party collection for "direct control over refresh timing"; no cadence figure | 178M permits, 2,770+ jurisdictions | Not stated | Sacra summaries; Shovels API docs did not load |
| **BuildZoom** | Not stated | "70k new permits and 500k status updates daily" | "Review an individual contractor's work history"; 6M+ contractors | "contact information" | buildzoomdata.com |
| **Building Radar** | Yes: "planning or design phases"; triggers "Permit filings and planning applications" | Not stated | "network mapping" of GCs and architects | Buying centers | buildingradar.com blog |
| **Construction Monitor** | Not stated; issued permits | "leads added hourly" | Top/New Company reports | Not stated | constructionmonitor.com |
| Small players | Permit Pipeline (NYC, SF, Miami "before your competition" articles), many Apify scrapers | | | | getpermitpipeline.pages.dev; apify.com |

**What this means.** Early-stage commercial projects are not a gap: Dodge and
ConstructConnect have sold planning-stage leads for years, researched by
hundreds of people, and Shovels is adding planning signals. None of the pages
read claims **residential and light-commercial plan-review filings, linked to
the issued permit and the trade permits, with the GC-sub history** for a
specific metro. That combination is the defensible slice, and it is
unverified that they lack it: a side-by-side on the same Austin filings is the
only proof (ROADMAP E1).
