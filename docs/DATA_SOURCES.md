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
| Sync mode | `updated_at`, via the Socrata `:updated_at` system field (**to verify** in M1) |
| Integration status | Working in the prototype (`austin-tx`) |

### Miami-Dade County, FL: permit data layer

| Field | Value |
| --- | --- |
| Endpoint | `https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0` (ArcGIS REST table) |
| Auth | None |
| Terms | None stated on the service (no description, no copyright text). **Not reviewed**; check the Miami-Dade open data portal terms |
| Freshness | `dataLastEditDate` 2026-11-07 (verified), `hasStaticData: true`. Looks like a weekly full replace (to confirm over 3 weeks) |
| Volume | 139,389 rows (verified count), about 2 rolling years per the prototype |
| Paging | `maxRecordCount` 1000. The prototype found that `--max=6000` fails and pages of 500 work |
| Contractor | `ContractorNumber` (licence), `ContractorName`, `ContractorAddress`, `ContractorCity`, `ContractorState`, `ContractorZip`, `ContractorPhone`. Phone on 82% per the prototype README |
| Owner | `OwnerName` (stored, never displayed in v1) |
| Property | `PropertyAddress`, `City`, `State`, `FolioNumber` (parcel), `LegalDescription1/2`. **No ZIP** |
| Project | `MasterPermitNumber`, `ProcessNumber`, which allow an official project link |
| Work | `ApplicationTypeDescription`, `DetailDescriptionComments`, `ResidentialCommercial`, `ProposedUseDescription`, `Category1..10` with descriptions, `SquareFootage`, `StructureUnits`, `StructureFloors`, `EstimatedValue` (string) |
| Dates | `ApplicationDate`, `PermitIssuedDate`, `LastInspectionDate`, `LastApprovedInspDate`, `CoCcDate` (string) |
| Status | **No status column.** Stage is derived from dates (`src/sources.js`) |
| Unknowns | Does it include municipal permits (Miami, Hialeah, Miami Beach, ...) or only county-processed ones? Two count queries disagreed (139,389 total vs 413,757 with non-null phone), which needs re-checking |
| Sync mode | `snapshot`: when `dataLastEditDate` changes, page through the whole layer and diff by hash |
| Integration status | Working in the prototype (`miami-dade-fl`) |

## Candidate sources (verified fields, not integrated)

| Source | Endpoint | Freshness (verified) | Contractor fields | Notes |
| --- | --- | --- | --- | --- |
| Dallas, Building Permits | `https://www.dallasopendata.com/resource/e7gq-4sah.json` | Updated 2026-11-12 | One free-text `contractor` field, sometimes with phone and address | `issued_date` is text `MM/DD/YY`, so sort and filter need parsing. No status column. Dallas also publishes "Active Contractors" (`jhgk-eg9m`) with phone |
| Orlando, Permit Applications | `https://data.cityoforlando.net/resource/ryhf-m453.json` | "Updated daily"; updated 2026-11-12 | `contractor_name`, `contractor_phone_number`, `contractor_address` | Property and parcel owner names. About 1.1M rows. Applications, so earlier than issued |
| Chicago, Building Permits | `https://data.cityofchicago.org/resource/ydr8-5enu.json` | Updated 2026-11-12; latest issue 2026-11-11 | Contact slots by role (`contact_n_type/name`), city, state and ZIP only, **no phone** | Large volume. Needs phone enrichment |
| City of Miami, iBuildPermits | `https://gis.miami.gov/gis/rest/services/Maps/iBuildPermits/MapServer/0` | Latest issue 2026-11-13 | **None** | Has `MasterPermitNumber`, `FOLIO`. Use only if the county layer lacks City of Miami permits |
| Seattle | `https://data.seattle.gov/resource/76t5-zqzr.json` | Updated 2026-11-12 | `ContractorCompanyName` only | |
| Los Angeles | `https://data.lacity.org/resource/pi9x-tg5x.json` | Updated 2026-11-09; latest issue 2026-11-07 | None seen | |
| San Francisco | `https://data.sf.gov/resource/i98e-djp9.json` | Updated 2026-11-12 | None in the main table; a separate contacts dataset (`3pee-9qhc`) | |
| Phoenix, ShapePHX permits | `https://mapportal.phoenix.gov/pds/rest/services/ShapePHX/ShapePHXPermitsPoints_DL/MapServer/0` | "Updated on a weekly basis" | One `CONTACT` field (contents unknown) | `OWNER_NAME`, `APN` |
| Mecklenburg County (Charlotte) | metadata only | Weekly; metadata from 2019 | None | CO-required permits only. Skip |

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
