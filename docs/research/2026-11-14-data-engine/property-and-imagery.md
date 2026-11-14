# Property enrichment and imagery: sources, terms, cost (2026-11-14)

Research note for the data engine. Not legal advice; it feeds
`docs/COMPLIANCE.md` and `docs/DATA_SOURCES.md` but does not change them.

**Question.** Which official records and external providers give us a rich,
lawful property profile per permit (Austin / Travis County, Miami-Dade
including City of Miami, Raleigh / Wake County), and which imagery can show
the job site, at a cost that fits ~50k permits and ~30k distinct properties a
year?

**Short answer.**

1. **Free official records cover the profile.** County appraisal and parcel
   data already give 85-99% of what any vendor sells for these three
   counties. Vendors (Regrid, ATTOM, ReportAll, the rest) resell the same
   county rolls, so they lag on the same new parcels that cause our gaps.
   Most of what they add is fields we may not show: owner, mortgage, sale
   price, owner-occupied.
2. **Wake County is the cheapest next win.** Raleigh permits carry `pin`.
   Wake publishes parcels under **CC BY 4.0, updated each business day**, and
   a daily real-estate data file.
3. **The Austin gaps are a geometry problem, not a vendor problem.** Fix the
   15% TCAD miss and the 17% Census-geocoder miss with parcel geometry keyed
   on `tcad_id`, then address points. Measure before buying anything.
4. **Imagery: Google Street View Static, rendered live, never stored.** Pick
   the panorama with the free metadata call. Each image is checked against
   the parcel (distance, heading, capture date) and labelled. Mapillary
   (CC BY-SA) is the storable fallback. NAIP and state orthos give the
   public-domain aerial view.
5. **Estimated spend: $0-$75 a month** at pilot scale (Google beyond its
   free tier). No paid property provider is recommended yet. Each paid item
   below needs owner approval.

Legend for every claim: **V** = verified at the URL given, checked
2026-11-14. **I** = inferred (memory, secondary source, or a page that would
not render); treat it as a hypothesis. **U-A** = government host not reachable
from this container: unverified, check from Actions.

---

## 1. What we already have (from `docs/DATA_SOURCES.md`, not redone)

| Market | Source | Join | Link rate | Fields we use |
| --- | --- | --- | --- | --- |
| Austin | TCAD supplemental export (`ingest/enrich_tcad.js`) | `tcad_id` = `geo_id` | 85% of permits (91.6% of distinct IDs) | Year built, living area (sum of floor rows), state code, value |
| Austin | US Census batch geocoder (`ingest/geocode.js`) | Address | ~83% (17% miss, mostly new streets) | Lat/lon with match type |
| Miami-Dade | PA Property Point View (ArcGIS, weekly) | `FOLIO` | ~97-99% | DOR code, beds/baths, floors, units, areas, lot, year built, assessed value, X/Y |
| City of Miami | Permit layer has `FolioNumber` (12 digits) and lat/lon | Folio, leading-zero fix | Not measured | Same as county via folio |
| Raleigh | Permit layers have `pin` | Not built | 0% | None yet |

The rules that bind every source below are already written down: Travis CAD
use rules (COMPLIANCE 1.11) and hard rule 5 (owner names stored, never
displayed).

---

## 2. Part A: property data providers

### 2.1 Free and official sources

| Source | Coverage | Key fields | Update | Licence / terms | Match approach | Effort | Basis |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Travis CAD** exports | Travis County | `prop_id`, `geo_id`, situs, state codes, market/appraised value, `IMP_DET` year built and area by floor type; owner, deed, exemptions (**never load**) | Certified yearly (July) plus supplements (SUPP 336 on 2026-11-10) | No licence stated. Tax Code §25.027 / §25.025 / §22.27 limits (COMPLIANCE 1.11) | `tcad_id` = `geo_id` | Built | V (DATA_SOURCES, 2026-11-13) |
| **TCAD GIS parcel polygons** | Travis County | Parcel geometry keyed by `prop_id`/`geo_id` | I: re-posted with the roll | I: same as the exports | `geo_id` → polygon centroid | Low | **I**: confirm the file exists and its key from Actions (U-A) |
| **TxGIO StratMap Land Parcels** | Statewide, but "Not all counties are available"; Travis not confirmed on the page | TxGIO land-parcel schema (PDF; fields not read). Attributes "as-is" from appraisal districts, may be null | "Will attempt to refresh annually"; filenames carry `YYYYMM` | "Available at no cost"; content © TxGIO/TWDB "unless otherwise noted"; "not survey grade". No named licence | `prop_id` / `geo_id` (schema to read) | Low | V: [land-parcels page](https://www.geographic.texas.gov/stratmap/land-parcels.html). Endpoint `feature.geographic.texas.gov/.../stratmap25_land_parcels_48` seen in search, not opened |
| **Miami-Dade PA** Property Point View | Miami-Dade, 944,398 points | As in section 1. Also `TRUE_OWNER1-3`, `DOS_1`, `PRICE_1` (sale date and price), mailing address | Weekly (Saturdays) | "As is", "for illustration only"; rights not granted are reserved | `FOLIO` | Built | V (DATA_SOURCES) |
| **Florida statewide parcels** (FDOR tax-roll NAL plus county GIS, compiled by UF GeoPlan / FGDL, served via FGIO) | 67 counties | NAL: parcel ID, DOR use code, just/assessed value, actual year built, total living area, **owner name and mailing address, two most recent sale prices and dates**, homestead | Annual (tax-roll cycle) | I: public record (Fla. ch. 119); FGDL redistribution terms not read | Folio = parcel ID | Low | **I/U-A**. Search found GeoPlan metadata ([parcels_2020.xml](https://www.geoplan.ufl.edu/agol/metadata/xml/parcels_2020.xml)) and an FDOT parcel service; nothing opened. Not needed while the PA layer links 97-99% |
| **Wake County parcels** (open data) | Wake County | Parcel boundaries "with address and revenue-related information" (field list not shown; I: `PIN_NUM`, `REID`, owner, deed book, building/land value, year built, heated area, total sale price and date, type-and-use, units, acreage) | **"Updated at the end of every business day"**; data last modified 2026-03-27 per data.gov | **CC BY 4.0** (data.gov record) → credit Wake County on every screen and export | Raleigh `pin` = `PIN_NUM` | Low (ArcGIS FeatureServer, the same pattern as Raleigh) | V: [data.gov record](https://catalog.data.gov/dataset/parcels-5a656) (ArcGIS item `f5ed009c66e844ec82f29064edd95017`). Field names **I**: the item page is JS-only; read them from Actions |
| **Wake real-estate data file** | Wake County | Full CAMA extract (.xlsx/.mdb/.txt/.zip) with a record layout PDF and code descriptions. "Sale" fields are sales data; other fields are current CAMA characteristics. Separate Qualified Sales file (24 months) | **Refreshed daily** (values from the 2024-01-01 reappraisal) | No terms on the page; links to wake.gov/disclaimers (not read). Cost not stated (I: free) | REID / PIN | Low-medium (fixed-width or xlsx) | V: [wake.gov data files page](https://www.wake.gov/departments-government/tax-administration/data-files-statistics-and-reports/real-estate-property-data-files); files on `services.wake.gov/realdata_extracts/` (U-A) |
| **NC OneMap statewide parcels** | All 100 NC counties plus Eastern Band of Cherokee lands | 69 fields: `parno`, `altparno`, `siteadd` (plus parsed parts), `scity`, `szip`, `gisacres`, `parusecode/desc`, `improvval`, `landval`, `parval`, `struct`, `structyear`, `saledate`, `owntype`, `subowntype`, **`ownname`, `ownfrst`, `ownlast`, `mailadd`**, `sourcedate`, `transfdate`. **No heated area, no sale price** | Per-county transform dates (`transfdate`), so not daily | Credits the NC Integrated Cadastral Data Exchange (EPA-funded) and the counties; no licence in the layer JSON | `parno` / `altparno` | Low (`maxRecordCount` 5000) | V: [layer JSON](https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/0?f=pjson) |
| **Microsoft US Building Footprints** | Nationwide | Footprint polygons; the 2017 release has heights (from a DTM); 2018 composite Bing imagery, dates uncertain | Static releases | **ODbL** ("same Open Database License as OpenStreetMap") | Spatial join to the parcel polygon | Medium | V: [OSM wiki](https://wiki.openstreetmap.org/wiki/Tag:source=microsoft/BuildingFootprints) |
| **Overture Maps** buildings | Global; conflates OSM (priority), Esri Community Maps, Microsoft and Google ML footprints | `height`, `has_parts`, building parts (OSM); `num_floors` / `class` per the schema (not read) | **Monthly** | Buildings theme **ODbL** (because it includes OSM) | Spatial join | Medium (GeoParquet on S3/Azure) | V: [buildings guide](https://docs.overturemaps.org/guides/buildings) |
| **Overture Maps** addresses | US and others; sourced from government open address data | Address points, parsed components | Monthly | I: per-source licences; not read | Address normalisation, then nearest point | Medium | **I** ([address theme announcement](https://overturemaps.org/blog/2024/introducing-overture-maps-address-theme/), not opened) |
| **OpenAddresses** | Patchy; county and city address-point files | Address points | Irregular | I: licence varies by source file | Same | Medium | **I** (not checked) |
| **US Census geocoder** | National | Lat/lon, match type, tract | TIGER benchmarks | COMPLIANCE 1.13 (counsel Q4) | Address | Built | V (DATA_SOURCES) |

### 2.2 Commercial providers

Published prices are rare. Where a page gave no number, the cell says so; no
price below is estimated from memory.

| Provider | Coverage | Fields relevant to us | Owner / sale / individual data | Published price | Redistribution, display, caching | Match | Effort | Basis |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Regrid** (ex-Loveland/Landgrid) | Nationwide parcels | Standard and Premium schema (APN, normalised address, lat/lon, land use, zoning, lot, year built, building sqft from the county roll), parcel tiles. Enterprise only: matched building footprints with heights, secondary addresses, standardised zoning, "Enhanced Ownership", batch API, typeahead | Owner in the standard schema; "Enhanced Ownership" add-on | Self-serve: "Start with 2,000 Parcel records per month plus additional per record pricing"; dollar figures are on `app.regrid.com/api/plans`, which rendered empty. Enterprise: annual, >10,000 records/month, custom | Not on the plan pages; see `regrid.com/terms` (not read) | Address, lat/lon or APN | Low (REST, tiles) | V: [plan options](https://support.regrid.com/reference/plan-options); prices **not captured** |
| **ATTOM** Property API | ~155M US properties (I) | Assessment profile, building characteristics, AVM, sales and comps, schools, boundaries; permits and parcel tiles as add-ons | **Ownership and mortgage**, sales history, pre-foreclosure in both plans | **Basic Property "Starting at $500/month"**; Premium "Contact us"; free trial (length not stated) | Terms not on the pricing page | Address or ATTOM ID | Low | V: [ATTOM pricing](https://www.attomdata.com/solutions/delivery/property-data-api/pricing/) |
| **Estated** (now ATTOM) | Same data as ATTOM | v4 property object | Owner, sales, mortgage | No price on the ATTOM help page | n/a | Address | Low | V: ATTOM [help article](https://cloud-help.attomdata.com/article/661-is-estated-api-being-replaced): ATTOM "continues to make the API available to existing customers", a new ATTOM API will keep Estated's inputs and outputs, at least six months' notice before any deprecation (page updated 2023-06-13). **Successor: the ATTOM API / ATTOM Cloud.** I: new Estated sign-ups appear closed |
| **RentCast** | Nationwide | Property records, rent and value AVMs, listings | Owner and sale history (I, schema page not read) | Developer plan: **50 free requests/month**, then "a small overage fee"; other plan prices only on rentcast.io/api (not read) | Not on the billing page | Address | Low | V: [billing and pricing](https://developers.rentcast.io/reference/billing-and-pricing) |
| **ReportAll USA** | Nationwide parcels | Parcel number, acreage, buildings count, land cover, flood zone, census block, elevation | **Owner, mailing address, "Owner Occupied"** | **Travis County file $200** (434,980 parcels, 2026-Q4, six months of updates); no year built, sqft, land use or value listed. API price not shown | Terms not read | APN, spatial | Low | V: [Travis store page](https://reportallusa.com/store/Texas/48453) |
| **Precisely** (Property Attributes, PreciselyID) | Nationwide | Property and building attributes, address fabric | Owner and sales in some products (I) | Not published (I) | Licence-bound (I) | PreciselyID | Medium-high | **I** (not checked) |
| **Cotality** (CoreLogic, renamed 2025) | Nationwide; deepest tax and deed history | Tax, deed, mortgage, building, AVM | Full owner, mortgage, sale | Not published (I) | Enterprise licence (I) | APN / CLIP ID | High | **I** (not checked) |
| **Melissa** Property API | Nationwide | Property and address verification | Owner, sale | Credit-based; not checked | Not checked | Address (strong standardisation) | Low | **I** (not checked) |
| **LightBox** (SmartFabric, parcels) | Nationwide | Parcels, building footprints, zoning, address fabric | Owner | Not published (I) | Enterprise licence (I) | LightBox IDs | High | **I** (not checked) |

**What the vendors would add for us.** For our three counties, mostly
standardisation (one schema for three counties), parcel geometry, zoning and
footprint heights (Regrid enterprise), and AVMs (ATTOM). Owner, mortgage,
sale and owner-occupied fields are the core of their products and are
exactly what our rules bar from display. None of them promises fresher data
for new subdivisions than the county roll they copy (I). So they do not fix
the measured Austin gap.

**Privacy flags on vendor data.** Every commercial product above returns
owner names, and most return mortgage or sale data and an owner-occupied
flag. If one is adopted, the request must name an explicit field list, as we
do with the Miami-Dade `outFields`, so those fields are never fetched. A
response that carries them anyway must be dropped at load, the same way the
TCAD rules work. Commercial licences also usually limit caching, display and
redistribution to the licence term (I: terms not read). A vendor value shown
to customers therefore needs its own provenance tag and a purge path for when
the contract ends.

---

## 3. Recommended property stack (tiered)

**Tier 1: county records, joined on the permit's own parcel key (now).**

| Market | Key | Source | Load | Never load |
| --- | --- | --- | --- | --- |
| Austin | `tcad_id` | TCAD exports (built) plus TCAD or StratMap polygons for centroids | Already built; add geometry | Owner, deed, exemptions, sales, photos, sketches (TCAD rules) |
| Miami-Dade and City of Miami | Folio (13 digits; pad the city's 12) | PA Point View (built) | Add `CONDO_FLAG`, `SUBDIVISION` | `TRUE_OWNER*`, mailing address, `PRICE_1`; `DOS_1` only if section 5 allows |
| Raleigh | `pin` | Wake parcels (CC BY 4.0, daily) for geometry and facts; the Wake data file for heated area if the layer lacks it | PIN, REID, land use, year built, heated area, units, acreage, land and building value | Owner, mailing address, deed book, sale price, exemptions |

New work: a `wake-parcels` enrichment connector (fixture first, hard rule 10),
then a Raleigh link-rate measurement like Austin's.

**Tier 2: fix coordinates without a vendor (M1 measurement).**

1. Permit coordinates where the source has them (Austin 60.6% recent; City of
   Miami 100%).
2. Parcel centroid from the county polygon via the parcel key. This should
   cover most Census misses, because new-street permits still carry a
   `tcad_id` (99.5% filled). **Measure:** share of the 17% Census misses that
   have a TCAD-matched `tcad_id`.
3. Address points (Overture addresses, or the City of Austin / CAPCOG 911
   address points: I, not checked), then Census.
4. Record `method` and `quality` (already in `permit_locations`).

Do **not** use Google Geocoding to fill stored coordinates. The Service
Specific Terms allow lat/lng from the Geocoding API to be cached only for a
limited period (30 days; V that the limit applies to Geocoding, not to
Street View: [service terms](https://cloud.google.com/maps-platform/terms/maps-service-terms/.),
last modified 2026-10-15).

**Tier 3: building footprints (optional, M2+).** Overture buildings (ODbL,
monthly). Uses: "main building footprint area" and "number of structures on
the parcel" as scoring features, and a better camera target than the parcel
centroid (section 4.3). ODbL means attribution ("© OpenStreetMap
contributors, Overture Maps Foundation") on any screen that shows a derived
value. A derived footprint table must never be exported wholesale, because a
distributed derivative database would have to be ODbL too.

**Tier 4: paid, only against a measured gap (needs owner approval).**

| Trigger | Candidate | Cost basis |
| --- | --- | --- |
| A fourth market whose county publishes no usable roll | Regrid self-serve (2,000 records/month included) or a ReportAll county file ($200 for Travis, an example) | Regrid dollar price not captured; ReportAll V |
| Customers need zoning across markets | Regrid enterprise (standardised zoning) | Not published |
| AVM or job-value modelling | ATTOM Basic | From $500/month (V) |

Not recommended for the pilot: ATTOM, Cotality, Precisely or LightBox. Each
costs from $6,000 a year up, and the main thing they add is fields we may not
display.

---

## 4. Part B: imagery

### 4.1 Sources

| Source | Availability / coverage | Licence and storage | Cost | Capture date | Basis |
| --- | --- | --- | --- | --- | --- |
| **Google Street View Static API** | Dense street-level coverage in all three metros (I) | Google Maps Platform ToS: "Content pre-fetching, indexing, storing, or caching is generally prohibited, except for place IDs and panorama IDs"; "you can store panorama ID values indefinitely". Bulk download of Street View images is prohibited. "Don't create content based on Google Maps Content", for example "construct a location index from Street View imagery". "Google Maps" attribution must stay visible | **Essentials SKU: 10,000 free a month**, then **$7.00 per 1,000** (to 100k), $5.60 (100k-500k), $4.20, $2.10, $0.53 | Via metadata | V: [pricing](https://developers.google.com/maps/billing-and-pricing/pricing), [policies](https://developers.google.com/maps/documentation/streetview/policies) |
| **Street View metadata** | Same | "Available at no charge"; "No quota is consumed". Returns `copyright`, `date`, `location {lat,lng}`, `pano_id`, `status` (`OK`, `ZERO_RESULTS`, `NOT_FOUND`, ...). The metadata page says "Panoramas may change IDs over time, so don't persist this ID": store the address or coordinates and look again | **Free, unlimited** (pricing page: "Unlimited") | `date` is year-month or year only; omitted when unknown | V: [metadata docs](https://developers.google.com/maps/documentation/streetview/metadata) |
| Google Dynamic Street View (JS) | Same | Same ToS | 5,000 free, then $14.00 per 1,000 | Same | V (pricing) |
| Google Map Tiles API (2D, Street View tiles, Photorealistic 3D) | Global | Map Tiles policies (not read) | 2D: 100,000 free, $0.60/1k. Street View tiles: 100,000 free, $2.00/1k. 3D: 1,000 free, $6.00/1k | n/a | V (pricing) |
| Google Aerial View API | Selected US addresses (I) | Video IDs cacheable | 5,000 free, $16.00/1k | n/a | V (pricing) |
| Google Static Maps (satellite) | Global | No storing | 10,000 free, $2.00/1k | Not exposed | V (pricing) |
| **Mapillary** (Meta) | Crowd-sourced; coverage in Austin, Miami and Raleigh unmeasured, likely patchy off arterials (I) | **"All images on Mapillary are shared under a CC-BY-SA license"**; credit as "Title" + link, by "username" + profile link, "licensed under CC-BY-SA". API terms at mapillary.com/legal not read; the API needs an access token (sign-up) | Free (I) | `captured_at`, `compass_angle`, computed geometry in the API (I) | V: [licence page](https://help.mapillary.com/hc/en-us/articles/115001770409-Licenses) |
| Azure Maps (Bing successor) imagery tiles | Global | Azure Maps terms (not read) | **1,000 free imagery tiles a month**; paid rates shown only as "$-", and 500K+ "Contact Us" | Not exposed | V: [Azure Maps pricing](https://azure.microsoft.com/en-us/pricing/details/azure-maps/). I: Bing Maps for Enterprise is being retired in favour of Azure Maps |
| **Esri World Imagery** | Global, high-resolution in US metros (I) | ToU summary (2025-04-21): "Download, redistribute or self-host any content hosted by Esri" is prohibited, as are "Systematically harvest basemap tiles" and "Redistribute basemap tiles"; attribution to Esri and its data providers is required; without Esri software "you must purchase an ArcGIS Online subscription"; screen captures allowed | Subscription; not priced here | Not exposed in the basemap | V: [ToU summary PDF](https://www.esri.com/content/dam/arcgisonline/docs/tou_summary.pdf) |
| **NAIP** (USDA FPAC) | CONUS, about 60 cm, leaf-on, every 2-3 years per state | US Government work, public domain (I; standard for NAIP). Store, crop and serve freely | Free | Acquisition date in metadata | **I**. TxGIO serves NAIP image services (`imagery.geographic.texas.gov/.../NAIP22_NCCIR_60cm`, seen in search, U-A) |
| **TxGIO / StratMap orthoimagery** | Texas; 6-12 in. urban orthos on regional cycles (I) | Free from the TxGIO DataHub (I) | Free | Per project | **I/U-A** |
| **Miami-Dade orthos** | County flights; county service `imageserverintra.miamidade.gov` (intranet host) and an SFWMD Miami-Dade ImageServer | Terms unknown | Free (I) | Per flight | **I/U-A**: [SFWMD ImageServer](https://geoweb.sfwmd.gov/agsimg1/rest/services/Imagery/MiamiDade/ImageServer), [county imagery hub](https://gis-mdc.opendata.arcgis.com/pages/imagery) (not opened) |
| **Wake / NC orthos** | NC Orthoimagery Program, statewide cycles (I) | Public (I) | Free | Per flight | **I/U-A** |
| **Nearmap** | US metros, 2-3 captures a year (I) | Licensed; no redistribution (I) | No commercial price published. A public co-op contract shows the scale: NCTCOG 2026 annual subscriptions run **$5,200** (population 1-3,000) to **$240,500** (750,000+) for orthos, and $6,025 to $283,812.50 with obliques, for "participating agencies" | Per capture | V: [NCTCOG 2026 pricing](https://www.nctcog.org/getmedia/896281ed-b5c4-4a54-9cd3-cc219c4a2311/Subscription_Pricing_2026.pdf) |
| **EagleView** (Pictometry) | US counties, oblique | Licensed (I) | Not published | Per flight | **I** |
| **Apple Look Around** | Major US metros (I) | No public server-side image API; only inside MapKit apps and views, under Apple's terms (I) | n/a | Not exposed | **I** (not checked) |
| **Assessor photos and sketches** | TCAD: none published in the export; Wake account pages appear to offer photos and sketches (I); Miami-Dade PA site shows property pictures (I) | Texas Tax Code §25.027 bars posting residential photos or sketches from appraisal records (COMPLIANCE 1.11). Wake and Miami-Dade: no reuse terms read | Free | n/a | I. **Do not use**: no licence and unneeded |

### 4.2 What Mapillary's share-alike means for us

CC BY-SA attaches to the image and to **adaptations** of it, not to the page,
the lead record or our database around it. Showing a Mapillary photo
unchanged, with the author credit and a licence link, puts no duty on the
rest of the product. If we crop, annotate or overlay it (for example, drawing
the parcel outline on it), the edited image must itself be CC BY-SA and
credited. Text facts we read off an image are not adaptations (I; counsel can
confirm). Mapillary images can be stored and served from our own storage,
which Google's cannot. The Mapillary API terms are a separate contract and
must be read before use.

### 4.3 Confirming the image shows the right parcel

Done at render time. Nothing from Google is persisted except, optionally,
`pano_id`. The policies page allows storing it indefinitely, but the metadata
page says IDs change, so re-query on `ZERO_RESULTS`.

1. **Target point.** Use the centroid of the largest building footprint on
   the parcel (Tier 3), else the parcel polygon centroid, else the permit
   point. Record which one was used.
2. **Find a panorama.** Call metadata (free) with `location=<target>`.
   I: the Static API also takes `radius` (default 50 m) and `source=outdoor`.
   Use them to exclude indoor and user-uploaded panoramas.
3. **Distance check.** Compute the haversine distance *d* from the panorama
   location to the target. Accept *d* ≤ 40 m. From 40 to 60 m, accept as
   "low". Above 60 m, or `ZERO_RESULTS`, show no image and say "No street
   image near this parcel".
4. **Heading.** Use the initial bearing from the panorama to the target,
   passed as `heading`. Set `fov` from distance (about 90° under 15 m, 60°
   at 15-40 m), with `pitch` 0-10.
5. **Right side of the road.** The pano-to-target segment must cross the
   parcel's frontage edge and no other parcel's polygon before reaching it.
   On corner lots, prefer a panorama on the street named in the situs
   address (match it to Overture or OSM street names).
6. **Capture date versus permit.** Compare the metadata `date` with the
   permit's issue date:
   - Image older than the permit, and the permit is new construction
     (Austin `DS`/new building, Raleigh new-building `workclass`): label it
     "Street image from 2021-05, before this permit. May show an empty lot or
     an earlier building."
   - Image more than 36 months old: label it "Older street image (2019)".
   - No `date`: "Capture date unknown".
7. **Multi-unit.** For condos (`CONDO_FLAG`, unit counts above 1), label it
   "Building view; unit not identifiable".
8. **Label.** "Street view toward the parcel, captured YYYY-MM, about *d* m
   away. Google Maps." with a confidence of **high** (*d* ≤ 25 m, the
   frontage check passes, captured within 36 months), **medium** (passes the
   checks with an older image or *d* 25-40 m) or **low**. Never say
   "photo of the property". A customer action ("wrong building") is logged as
   feedback.
9. **Mapillary fallback.** Choose images within 40 m whose `compass_angle`
   is within ±30° of the bearing to the target and whose `captured_at` is
   newest. Apply the same date and label rules, plus the CC BY-SA credit.
10. **Aerial.** NAIP or state ortho chip centred on the parcel with its
    outline. Public domain, so it can be pre-rendered and cached. Label it
    with the acquisition date.

**Open ToS question (needs reading before build).** The Google Maps Platform
Terms have a "no use with a non-Google map" restriction (I: §3.2.3(e), not
re-read here). Our map uses OSM/Leaflet tiles. A Street View thumbnail on the
job page, not on the map, is probably outside it, but read the clause first.
Also confirm that computing heading and distance from metadata at request
time, without storing them, is not "creating content based on Google Maps
Content". Not storing the results is the conservative design.

---

## 5. Field-level privacy policy

This extends COMPLIANCE rule 1 and the Travis CAD rules to every market and
vendor. **Load** = written to our tables. **Show** = API, screen, digest or
export.

| Field | Austin (TCAD) | Miami-Dade PA | Wake | Vendors | Policy |
| --- | --- | --- | --- | --- | --- |
| Parcel ID, situs address, lat/lon, land use | Load, show | Load, show | Load, show | Load, show | Show, with source and roll year (rule 6) |
| Year built, living/heated area, stories, units, lot size | Load, show | Load, show | Load, show | Load, show | Show as "appraisal record, {year}" |
| Beds and baths | Not in the load list | Load, show | Load (if present), show | Load, show | Show; residential detail, low risk |
| Land and improvement value | Load (allowed); show only as a **band** | Assessed value, as a band | As a band | As a band | Proposed: show bands (for example $250-500k) as a job-size signal, not exact values; counsel Q9 |
| AVM or market estimate | n/a | n/a | n/a | ATTOM, RentCast | Do not load in v1 |
| **Owner name** | **Never load** | Leave out of `outFields` | Do not load | Exclude from requested fields | Rule 5; ADR-10 gate |
| Owner type (business, government, individual) | Only from state or land-use codes | Only from DOR code | `owntype` from NC OneMap if present | Vendor flag | Show "commercial / government / residential" from use codes only. Deriving it from names is a counsel question (Q5) |
| Owner mailing address | Never | Never | Never | Never | Never load |
| **Sale price** | **Never** (§22.27, TCAD rules) | Do not load in v1 | Do not load in v1 | Never request | Florida and NC sale prices are public, but a home's price paid is personal; keep it out until ADR-10 |
| Sale date | Never (deed fields) | Internal scoring only ("sold in the last 12 months") | Internal scoring only | Never | Not displayed; recency flag only after counsel review |
| Exemptions (homestead, over-65, veteran, disability), owner-occupied | Never | Never | Never | Never (ReportAll "Owner Occupied", ATTOM) | Never load: they reveal age, disability or residence |
| Mortgage, lien, foreclosure | n/a | n/a | n/a | Never | Never load |
| Confidential or protected owners | Skip the parcel on the flags (TCAD rule 3) | I: skip folios whose owner field shows a confidentiality marker. Detect at load, store only a boolean | I: check how NC confidential-address participants appear in the data | Ask the vendor | Counsel Q9 |
| Assessor photos and sketches | Never (§25.027) | Never | Never | Never | Never load |
| Street View image | n/a | n/a | n/a | Google | Never stored; shown only for a parcel with a permit, labelled; add a `suppressions` kind (`parcel_image`) so an owner's removal request hides it |
| Mapillary image | n/a | n/a | n/a | Mapillary | May be cached; credit the author; honour the same suppression |
| Footprint-derived values | n/a | n/a | n/a | Overture / Microsoft | Show with the ODbL credit; no bulk export |

Attribution lines to add to `attribution()`, digests and exports where
values appear: "Travis Central Appraisal District, {roll year}", "Miami-Dade
County Property Appraiser", "Wake County (CC BY 4.0)", "City of Miami (CC BY
4.0)", "Google Maps", "Mapillary / {username}, CC BY-SA", "© OpenStreetMap
contributors, Overture Maps Foundation (ODbL)", "USDA NAIP".

---

## 6. Monthly cost at our scale

Assumptions (I): 30k distinct properties a year, about 2,500 new a month.
Images load only when a customer opens a job page. Pilot: about 10-30
customers opening 300 job pages each a month, so 3,000-9,000 image loads.
Each image loads once per open; it cannot be cached.

| Item | Volume / month | Unit price (V) | Monthly |
| --- | --- | --- | --- |
| County records (TCAD, Miami-Dade PA, Wake), StratMap, NC OneMap, Census | All | Free | $0 |
| Overture buildings and addresses | Monthly file | Free | $0 (storage only) |
| Street View metadata | 1 per job-page open, plus retries | Free, unlimited | $0 |
| Street View Static images | 3,000-9,000 (pilot); 20,000 (about 70 customers) | 10,000 free, then $7.00/1k | **$0** in the pilot; **$70** at 20,000 |
| Mapillary fallback | Few | Free (I) | $0 |
| NAIP / ortho chips | 2,500 pre-rendered | Free | $0 |
| **Recommended stack total** | | | **$0-$75** |
| Optional: ATTOM Basic | | From $500 | +$500 (not recommended) |
| Optional: Regrid self-serve | 2,000+ records | Not captured | Owner to price |
| Optional: Nearmap or EagleView | | Public co-op tiers from $5,200 a year | Not recommended |

Every paid or sign-up item (a Google Cloud billing account and API key, a
Mapillary token, any vendor trial) **needs owner approval**. Set a Google
budget alert and a per-day quota cap on the Static SKU (for example 600 a
day) so a bug cannot run up a bill.

---

## 7. Next steps (in roadmap order)

1. **M1 measurement (no spend):** of the Austin permits the Census geocoder
   misses, what share has a TCAD-matched `tcad_id`? Load TCAD or StratMap
   polygons from Actions and measure centroid coverage.
2. **Wake connector:** fetch the Wake parcels layer live, record a fixture,
   list its fields, write a `DATA_SOURCES.md` entry (hard rule 10), and
   measure the Raleigh `pin` link rate. Add the CC BY credit.
3. **Read before imagery is built:** Google ToS §3.2.3 (non-Google maps,
   derived content), the Map Tiles policies, the Mapillary API terms, and
   wake.gov/disclaimers.
4. **Imagery prototype (owner approval for the Google key):** run the
   section 4.3 checks on 200 permits per market and hand-check them. Report
   the share that is high, medium or low, and how often they are wrong.
5. **Counsel additions:** banded values, owner type derived from names,
   sale-date recency, a removal path for Street View images (add to Q5 and
   Q9).

---

## Sources

Checked 2026-11-14 unless noted. V = content read; S = seen in search
results only.

- V: Google Maps Platform pricing: https://developers.google.com/maps/billing-and-pricing/pricing
- V: Street View metadata: https://developers.google.com/maps/documentation/streetview/metadata
- V: Street View policies: https://developers.google.com/maps/documentation/streetview/policies
- V: Google Maps Platform Service Specific Terms (last modified 2026-10-15): https://cloud.google.com/maps-platform/terms/maps-service-terms/.
- V: Regrid plan options: https://support.regrid.com/reference/plan-options
- V (no prices rendered): https://regrid.com/pricing, https://app.regrid.com/api/plans
- V: ATTOM API pricing: https://www.attomdata.com/solutions/delivery/property-data-api/pricing/
- V: Estated status: https://cloud-help.attomdata.com/article/661-is-estated-api-being-replaced
- V: RentCast billing: https://developers.rentcast.io/reference/billing-and-pricing
- V: ReportAll Travis County: https://reportallusa.com/store/Texas/48453
- V: Wake County parcels (data.gov): https://catalog.data.gov/dataset/parcels-5a656
- V: Wake real-estate data files: https://www.wake.gov/departments-government/tax-administration/data-files-statistics-and-reports/real-estate-property-data-files
- V: NC OneMap parcels layer: https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/0?f=pjson
- V: TxGIO StratMap land parcels: https://www.geographic.texas.gov/stratmap/land-parcels.html
- V: Overture buildings guide: https://docs.overturemaps.org/guides/buildings
- V: Microsoft footprints licence: https://wiki.openstreetmap.org/wiki/Tag:source=microsoft/BuildingFootprints
- V: Mapillary licences: https://help.mapillary.com/hc/en-us/articles/115001770409-Licenses
- V: Esri ToU summary (2025-04-21): https://www.esri.com/content/dam/arcgisonline/docs/tou_summary.pdf
- V: Azure Maps pricing: https://azure.microsoft.com/en-us/pricing/details/azure-maps/
- V: NCTCOG Nearmap subscription pricing 2026: https://www.nctcog.org/getmedia/896281ed-b5c4-4a54-9cd3-cc219c4a2311/Subscription_Pricing_2026.pdf
- S: Florida parcels metadata (UF GeoPlan): https://www.geoplan.ufl.edu/agol/metadata/xml/parcels_2020.xml
- S: SFWMD Miami-Dade ImageServer: https://geoweb.sfwmd.gov/agsimg1/rest/services/Imagery/MiamiDade/ImageServer
- S: Miami-Dade imagery hub: https://gis-mdc.opendata.arcgis.com/pages/imagery
- S: TxGIO NAIP image service: https://imagery.geographic.texas.gov/server/rest/services/NAIP/NAIP22_NCCIR_60cm/ImageServer
- S: NAIP catalogue: https://catalog.data.gov/dataset/national-agriculture-imagery-program-naip-imagery
- S: Overture address theme: https://overturemaps.org/blog/2024/introducing-overture-maps-address-theme/
- S: Mapillary terms: https://mapillary.com/legal
- Internal: `docs/COMPLIANCE.md` (1.11-1.14, Travis CAD use rules), `docs/DATA_SOURCES.md` ("Enrichment sources", 2026-11-13)
