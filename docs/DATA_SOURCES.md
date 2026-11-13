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
| Licence tag | `USGOV_WORKS`. Attribution: "City of Austin, Texas - data.austintexas.gov". The Terms of Use page did not render for review, so it has **not been read** |
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

### Miami-Dade County, FL: permit data layer

| Field | Value |
| --- | --- |
| Endpoint | `https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0` (ArcGIS REST table) |
| Auth | None |
| Terms | None stated on the service (no description, no copyright text). **Not reviewed**; check the Miami-Dade open data portal terms |
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
| Integration status | Working in the prototype (`miami-dade-fl`) |

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
| 1 | **City of Miami, FL** | ArcGIS `services1.arcgis.com/CvuPhqcTQpZPT9qY/.../Building_Permits_Since_2014/FeatureServer/0` | 7,815 | Daily (2026-11-12) | 0% | 96% | `ApplicationNumber`: E 45%, P 43%; sub differs 99% / 87%. Mechanical not found (suffix `ME` is rare; `MA` unknown) | 2012- | Not found on the service or the city data page. **Unread** | Add first: same market as the pilot, fixes the county layer's weekly lag and the open municipal-coverage question. Phones must come from the county layer or licences |
| 2 | **Philadelphia, PA** | ArcGIS `services.arcgis.com/fLeGjb7u4uXqeF9q/.../PERMITS/FeatureServer/0` | 11,249 | Daily (2026-11-12) | 0% | 86% | `parentjobid`: E 51%, P 54%, M 36%; sub differs 96% / 94% / 56%. Parcel: 64% / 67% / 48% | 2007- | "City of Philadelphia License": "reserves all rights in the database". **Must be read before use** | Best GC-sub structure measured outside Austin; no phone; licence terms are the blocker |
| 3 | **Raleigh, NC** | ArcGIS `services.arcgis.com/v400IkDOw1ad7Yad/.../Building_Permits/FeatureServer/0` and `.../Permits_Other_Than_Buildings/FeatureServer/0` | 1,482 building + 6,046 trade | Daily (2026-11-12) | 76% building, 85% trade; email 85-91% | 90-96% | Trade layer has `contractortype` (trade) and `workclass = "Sub Permit"` on about half of recent rows, `pin` 99.7%, `projectname` 22%. **Link rate not measured** (the 12-month trade query failed with 400/504; retry with smaller pages) | 2000- | No licence named on the city page. **Unread** | Best contact data after Austin, and sub-permits are explicit. Smaller volume |
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

### Recommended next 3

1. **City of Miami.** Cheapest to add and strengthens the pilot that already
   exists: daily instead of weekly, 7,815 permits per quarter, and the
   application number links building to electrical and plumbing permits at
   43-45% with a different company 87-99% of the time. Blocker to clear:
   no phone, so contact data has to come from the Miami-Dade layer
   (`ContractorPhone`, 82%) by licence or name match. That match rate is
   **not measured yet**.
2. **Raleigh.** The best contact data found outside Austin (76-85% phone,
   85-91% email), and the trade layer marks sub-permits and the trade of each
   contractor. Measure the link rate before committing; volume is about a
   quarter of Austin's.
3. **Philadelphia** if its licence allows commercial reuse, otherwise
   **Orlando.** Philadelphia has the strongest GC-sub links measured (51-54%
   by parent job, 64-67% by parcel) and the most volume after NYC, but its
   licence reserves all rights and there is no phone. Orlando is the user's
   pick and has phones on half its rows, but its links are parcel-only and
   weaker (26-34%).

What would change this ranking: Philadelphia's licence text; the City of
Miami to county phone match rate; Raleigh's measured link rate; and the
expediter caveat from Austin (if one company pulls trade permits for many
GCs, "sub differs" overstates real subs).

## Licence sources

| Source | Endpoint | Fields | Notes |
| --- | --- | --- | --- |
| Texas TDLR, All Licenses | `https://data.texas.gov/api/views/7358-krk7.json` | `license_type`, `license_number`, `business_name`, business address, `business_telephone`, `owner_name`, `owner_telephone`, expiry | About 967k rows, updated 2026-10-19. Covers electricians, A/C and others; **no general contractors** (Texas has no state GC licence). Plumbers are licensed by TSBPE (not checked) |
| Florida DBPR, construction | `https://www2.myfloridalicense.com/construction-industry/public-records/` | `CONSTRUCTIONLICENSE_1.csv`: name, DBA, address, licence number, status | **No phone.** Update frequency not stated |
| Florida DBPR, electrical | `https://www2.myfloridalicense.com/sto/file_download/extracts/lic08el.csv` | Same layout | **No phone** |

## Explicitly excluded

- **Washington County, OR:** CAPTCHA-gated. Do not automate. The legitimate
  path is a bulk-data request.
- **Portland, OR CSV:** columns never verified; disabled.
- **Clackamas County and Oregon statewide (Accela):** working, but out of the
  pilot (ADR-5).
