// One entry per supported area. Each entry declares a `type`, which selects the
// adapter in src/adapters/ that knows how to read it. Adding coverage means
// adding an entry here plus (if it's a new kind of portal) an adapter.
//
// These jurisdictions do NOT share a data format — see the notes on each.

const SOURCES = {
  'portland-or': {
    label: 'Portland, OR (City)',
    type: 'csv',
    maxPerRun: 1000,
    // TODO — still unverified. portlandmaps.com was unreachable from the
    // machine this was last worked on (connection times out, DNS resolves), so
    // the export URLs and the column headers below remain best guesses.
    // Pull a live sample and fix columnMap before trusting any output.
    appliedUrl: 'https://www.portlandmaps.com/reports/index.cfm?action=rs-intakes&format=csv',
    issuedUrl: 'https://www.portlandmaps.com/reports/index.cfm?action=rs-issued&format=csv',
    // Maps this source's real CSV column headers -> our internal field names.
    columnMap: {
      address: 'Address',
      workDescription: 'Description',
      valuation: 'Valuation',
      status: 'Status',
      permitUrl: 'PermitURL',
    },
    // No statusMap yet: the real status vocabulary is unknown until a live
    // sample is pulled. Values pass through lowercased, and anything that
    // isn't 'applied'/'issued' gets reported at the end of the run.
  },

  // Accela Citizen Access. Both entries share the 'accela' adapter; they differ
  // only by which ACA instance they point at. Selectors and page flow were
  // derived from real saved HTML — see recon/ and the notes in adapters/accela.js.
  'clackamas-county-or': {
    label: 'Clackamas County, OR',
    type: 'accela',
    baseUrl: 'https://aca-prod.accela.com/CLACKAMAS/',
    // The ACA grid's pager stops after 10 pages, so ~100 is the real ceiling.
    maxPerRun: 300,
    module: 'Building',
    // Observed live in the results grid. Accela's vocabulary is in-process
    // workflow states, not applied/issued, so everything that isn't finalized
    // is treated as 'applied' (still biddable — the point of the timing bonus).
    statusMap: {
      issued: 'issued',
      'permit issued': 'issued', // Oregon statewide's wording
      finaled: 'issued',
      completed: 'issued',
      'applicant upload': 'applied',
      lobby: 'applied',
      ready: 'applied', // observed live: ready to issue, not yet issued
      final: 'issued',        // work finalled = permit was issued
      prescreen: 'applied',
      pending: 'applied',
      'payment due': 'applied',
      'in review': 'applied',
      'under review': 'applied',
      submitted: 'applied',
      'application accepted': 'applied',
    },
    // The grid carries no description or valuation; both require a detail-page
    // visit. Turn this off to trade lead quality for a much faster, lighter run.
    fetchDetails: true,
    // Fees and inspections live on lazily-loaded tabs, so each permit costs two
    // extra round trips. Only worth it for sources where that detail matters;
    // turn off to roughly halve ingest time.
    fetchTabs: true,
    requestDelayMs: 1000,
  },

  'oregon-statewide': {
    label: 'Oregon statewide (ePermitting)',
    type: 'accela',
    baseUrl: 'https://aca-oregon.accela.com/oregon/',
    maxPerRun: 300,
    module: 'Building',
    statusMap: {
      issued: 'issued',
      'permit issued': 'issued', // Oregon statewide's wording
      // Observed live in ingested Oregon data — all pre-issuance workflow
      // states, so they count as 'applied' (still biddable).
      'app submitted': 'applied',
      'app submitted/addl info needed': 'applied',
      'app accepted/in review': 'applied',
      'in review/addl info needed': 'applied',
      'intake requirements needed': 'applied',
      'addl info needed': 'applied',
      'revision complete': 'applied',
      'ready to issue': 'applied',
      'plan review': 'applied',
      finaled: 'issued',
      completed: 'issued',
      'applicant upload': 'applied',
      lobby: 'applied',
      ready: 'applied', // observed live: ready to issue, not yet issued
      'in review': 'applied',
      'under review': 'applied',
      submitted: 'applied',
      'application accepted': 'applied',
    },
    fetchDetails: true,
    requestDelayMs: 1000,
  },

  // --- Texas ---------------------------------------------------------------
  //
  // Austin publishes permits as Socrata open data: one request returns up to
  // 1,000 fully-populated records, versus Accela's one browser navigation per
  // permit. Field names below were read off the live dataset metadata at
  // https://data.austintexas.gov/api/views/3syk-w9eu.json — not guessed.
  //
  // Uniquely among our sources, it publishes the CONTRACTOR'S PHONE directly.
  'austin-tx': {
    label: 'Austin, TX',
    type: 'socrata',
    domain: 'data.austintexas.gov',
    datasetId: '3syk-w9eu',
    // Two windows (ADR-11): :updated_at is useless because the publisher reloads
    // all 2.4M rows daily. issue_date catches new permits (complete 2-3 days
    // after issue); statusdate catches status changes on old permits (~5,600 a
    // week, 74% issued 30+ days earlier). Measured 2026-11-13.
    syncWindows: [
      { field: 'issue_date', days: 30 },
      { field: 'statusdate', days: 14 },
    ],
    // ~4,700 issued in 30 days plus ~11,000 status changes in 14 days, before
    // overlap. 25,000 leaves headroom (25 requests); ingest warns if hit.
    maxPerRun: 25000,
    // A backfill (--kind=backfill --days=N) may pull more; 12 months of Austin
    // is roughly 150k permits.
    backfillMaxPerRun: 200000,
    // Health alarm (ingest/health.js): the newest issue date we hold should be
    // at most this old. Austin publishes 2-3 days after issue, plus weekends.
    maxDataAgeDays: 5,
    // What the sources table must hold (checked by test/integration/registry
    // and src/sources.contract.test.js). Terms read 2026-11-13 (migration 007):
    // public domain, so redistribution yes; automated access not addressed in
    // the text that could be read, so unknown.
    registry: {
      jurisdiction: 'austin-tx', syncMode: 'date_window', expectedInterval: '1 day',
      terms: { url: 'https://data.austintexas.gov/stories/s/City-of-Austin-Open-Data-Terms-of-Use/ranj-cccq/', licenceTag: 'USGOV_WORKS', reviewedOn: '2026-11-13', automatedAccess: 'unknown', redistribution: 'yes' },
      fixture: 'test/fixtures/sources/austin-tx.json',
    },
    // The source's own point, where it has one (60.6% of recent permits,
    // 84.4% of all; ADR-15 item 4). The rest are geocoded by job-site address.
    coordinates: { lat: 'latitude', lng: 'longitude' },
    // Contractor extraction (src/contractors.js extractorFor). A permit's job is
    // its number without the type suffix: "2026-104544 BP" and "... EP".
    parties: {
      number: 'permit_number', typeField: 'permittype', typeFromNumberSuffix: true,
      buildingTypes: ['BP'], tradeByType: { EP: 'electrical', MP: 'mechanical', PP: 'plumbing' },
      job: { kind: 'numberBase' }, issued: 'issue_date',
      name: 'contractor_company_name', phone: 'contractor_phone', licence: null,
      rawTrade: 'contractor_trade', city: 'contractor_city', state: 'TX',
    },
    dateField: 'issue_date',
    defaultState: 'TX',
    fieldMap: {
      permitNumber: 'permit_number',
      permitType: 'permit_type_desc',
      workDescription: 'description',
      // Austin spreads valuation across many columns and populates none of them
      // on most rows; taking the first non-zero lifts coverage from 7% to ~25%.
      // The remainder genuinely have no valuation on file.
      valuation: [
        'total_job_valuation', 'total_valuation_remodel', 'building_valuation',
        'building_valuation_remodel', 'electrical_valuation_remodel',
        'mechanical_valuation_remodel', 'plumbing_valuation_remodel',
        'electrical_valuation', 'mechanical_valuation', 'plumbing_valuation',
      ],
      status: 'status_current',
      filedDate: 'issue_date',
      permitUrl: 'link',
      street: 'original_address1',
      city: 'original_city',
      state: 'original_state',
      zip: 'original_zip',
      jurisdiction: 'jurisdiction',
      contractorName: 'contractor_company_name',
      contractorPhone: 'contractor_phone',
      contractorTrade: 'contractor_trade',
      contractorCity: 'contractor_city',
      applicantName: 'applicant_full_name',
      applicantPhone: 'applicant_phone',
    },
    // Austin's vocabulary is handled centrally in src/status.js; the
    // applied/issued bucket scoring reads still needs mapping here.
    statusMap: {
      active: 'issued',
      final: 'issued',
      closed: 'issued',
      pending: 'applied',
      expired: 'issued',
      void: 'applied',
      withdrawn: 'applied',
      cancelled: 'applied',
      aborted: 'applied',
      'cancelled - contractor required': 'applied',
      'inactive pending revision': 'applied',
      'pending permit': 'applied',
      'expired - license': 'issued',
    },
  },

  // --- Florida -------------------------------------------------------------
  //
  // Miami-Dade publishes ~140k permits (rolling 2 years) as an ArcGIS feature
  // service, including CONTRACTOR PHONE. Field names below were read off the
  // live layer, not guessed:
  //   https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0?f=json
  //
  // Two real limitations, both verified against the live layer:
  //   1. There is NO property postal code — only a street address plus City and
  //      State. Miami permits are searchable by city, not by ZIP.
  //   2. There is NO status column. Every record has an issue date (0 rows
  //      without one), so stage is derived from dates — see deriveStatus below.
  'miami-dade-fl': {
    label: 'Miami-Dade County, FL',
    type: 'arcgis',
    layerUrl: 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0',
    // ~200 permits/day (106,070 in 18 months), published weekly with up to ~9
    // days' lag, so a 14-day window is ~2,800. The old 1,500 ceiling came from a
    // "fetch failed" at --max=6000 before the adapter retried; 5,000 was pulled
    // live with retries (recon/feasibility.js --only=miamiWindow).
    maxPerRun: 5000,
    backfillMaxPerRun: 40000,
    // Weekly refresh with up to ~9 days' lag (measured 2026-11-13).
    maxDataAgeDays: 17,
    // The service states no terms. The county site's user agreement (read
    // 2026-11-13, migration 007) grants no licence and reserves all other
    // rights, so redistribution is unknown until the lawyer answers.
    registry: {
      jurisdiction: 'miami-dade-county-fl', syncMode: 'snapshot', expectedInterval: '1 day',
      terms: { url: 'https://www.miamidade.gov/global/disclaimer/disclaimer.page', reviewedOn: '2026-11-13', automatedAccess: 'unknown', redistribution: 'unknown' },
      fixture: 'test/fixtures/sources/miami-dade-fl.json',
    },
    // A trade permit names its building permit in MasterPermitNumber;
    // "0000000000" means none, so the permit is its own job.
    parties: {
      number: 'PermitNumber', typeField: 'PermitType',
      buildingTypes: ['BLDG'], tradeByType: { ELEC: 'electrical', MECH: 'mechanical', PLUM: 'plumbing' },
      job: { kind: 'masterField', field: 'MasterPermitNumber', none: '^0+$' }, issued: 'PermitIssuedDate',
      name: 'ContractorName', phone: 'ContractorPhone', licence: 'ContractorNumber',
      rawTrade: null, city: 'ContractorCity', state: 'FL',
    },
    dateField: 'PermitIssuedDate',
    // Without an order, offset paging over the layer is not stable. Newest
    // first, ObjectId as the tiebreak.
    orderByFields: 'PermitIssuedDate DESC, ObjectId',
    defaultState: 'FL',
    fieldMap: {
      permitNumber: 'PermitNumber',
      // ApplicationTypeDescription is human-readable ("RE-ROOF/REPAIR");
      // PermitType is an opaque code ("MBLD").
      permitType: 'ApplicationTypeDescription',
      workDescription: 'DetailDescriptionComments',
      valuation: 'EstimatedValue',
      filedDate: 'PermitIssuedDate',
      address: 'PropertyAddress',
      city: 'City',
      state: 'State',
      owner: 'OwnerName',
      contractorName: 'ContractorName',
      contractorPhone: 'ContractorPhone',
      contractorLicence: 'ContractorNumber',
      contractorCity: 'ContractorCity',
    },

    /**
     * The layer has no status column, so the lifecycle stage is derived from
     * the dates it does publish. Stated explicitly rather than inferred from
     * wording that doesn't exist:
     *   Certificate of Completion present -> the job is done
     *   otherwise (every row has an issue date) -> approved
     */
    deriveStatus(attrs) {
      if (attrs.CoCcDate) {
        return { statusRaw: 'Certificate of Completion', status: 'issued', statusStage: 'finished' };
      }
      if (attrs.PermitIssuedDate) {
        return { statusRaw: 'Issued', status: 'issued', statusStage: 'approved' };
      }
      return { statusRaw: null, status: 'applied', statusStage: 'pending' };
    },
  },

  // City of Miami's own permit layer (the county layer above covers county-
  // processed permits). Fields read off the live layer on 2026-11-13 with
  // recon/capture_fixture.js --layer (fixture: test/fixtures/sources/miami-city-fl.json).
  // No contractor phone column: phones come later from the county layer or
  // licence files, never guessed.
  'miami-city-fl': {
    label: 'City of Miami, FL',
    type: 'arcgis',
    layerUrl: 'https://services1.arcgis.com/CvuPhqcTQpZPT9qY/arcgis/rest/services/Building_Permits_Since_2014/FeatureServer/0',
    // ~2,600 issued per 30 days (7,815 in 90 days, docs/DATA_SOURCES.md).
    maxPerRun: 6000,
    backfillMaxPerRun: 40000,
    // Edited daily (last edit 2026-11-13 when read); weekends plus slack.
    maxDataAgeDays: 4,
    registry: {
      jurisdiction: 'miami-fl', syncMode: 'date_window', expectedInterval: '1 day',
      // Item licence CC BY 4.0, read 2026-11-13 (PR #24). The credit line is
      // the sources row's attribution_text and shows wherever the data does.
      terms: { url: 'https://creativecommons.org/licenses/by/4.0/', reviewedOn: '2026-11-13', automatedAccess: 'unknown', redistribution: 'attribution' },
      fixture: 'test/fixtures/sources/miami-city-fl.json',
    },
    coordinates: { lat: 'Latitude', lng: 'Longitude' },
    // "BD26009606001E001": ApplicationNumber "BD26009606" ties the building
    // permit (B) to its trade permits; the letters before the last 3 digits are
    // the type. E, P, PG, ME are the trade suffixes seen (PR #21 link study);
    // others (ZS, ...) stay unclassified rather than guessed.
    parties: {
      number: 'PermitNumber', typeFromNumber: '^[A-Z]+\\d+([A-Z]+)\\d{3}$',
      buildingTypes: ['B'], tradeByType: { E: 'electrical', P: 'plumbing', PG: 'plumbing', ME: 'mechanical' },
      job: { kind: 'masterField', field: 'ApplicationNumber' }, issued: 'IssuedDate',
      name: 'CompanyName', phone: null, licence: null, rawTrade: null, city: 'CompanyCity', state: 'FL',
    },
    dateField: 'IssuedDate',
    orderByFields: 'IssuedDate DESC, ObjectId',
    defaultState: 'FL',
    fieldMap: {
      permitNumber: 'PermitNumber',
      permitType: 'ScopeofWork',
      workDescription: 'WorkItems',
      valuation: 'TotalCost',
      status: 'BuildingPermitStatusDescription',
      filedDate: 'IssuedDate',
      address: 'DeliveryAddress',
      parcelNumber: 'FolioNumber',
      contractorName: 'CompanyName',
      contractorCity: 'CompanyCity',
    },
    // 'hold' (1 row in the first pull) stays unmapped on purpose, like
    // Austin's 'on hold': paused or stopped is not knowable from the word.
    statusMap: { active: 'issued', final: 'issued' },
  },

  // Raleigh splits permits over two layers: building permits, and trade
  // ("Permits Other Than Buildings"). Fields read live 2026-11-13 (fixtures
  // raleigh-nc.json). Jobs link by parcel `pin` (72-85% of trade permits,
  // median 0 days apart, PR #21). The Open Raleigh Data Policy lets the City
  // "require the termination" of any use: switching off = remove from
  // PILOT_AREAS and set sources.enabled = false; purge = delete its permits and
  // raw_records by source (docs/CONNECTORS.md).
  'raleigh-nc': {
    label: 'Raleigh, NC',
    type: 'arcgis',
    layerUrls: [
      'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Building_Permits/FeatureServer/0',
      'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Permits_Other_Than_Buildings/FeatureServer/0',
    ],
    // ~2,500 per 30 days across both layers (7,528 in 90 days). The limit is
    // per layer, so a layer at the limit also trips the run's truncation alarm.
    maxPerRun: 6000,
    backfillMaxPerRun: 40000,
    maxDataAgeDays: 4,
    registry: {
      jurisdiction: 'raleigh-nc', syncMode: 'date_window', expectedInterval: '1 day',
      // Open Raleigh Data Policy (the layers' licence field), read 2026-11-13;
      // its page URL was not recorded, and the privacy policy it cites is unread.
      terms: { url: null, reviewedOn: '2026-11-13', automatedAccess: 'unknown', redistribution: 'unknown' },
      fixture: 'test/fixtures/sources/raleigh-nc.json',
    },
    // Building layer only; trade permits are geocoded by address.
    coordinates: { lat: 'latitude_perm', lng: 'longitude_perm' },
    // The type is the permittype text ("Building", "DSINSP - Electrical
    // (Residential)"). Right-of-way and other types stay unclassified.
    parties: {
      number: 'permitnum', typeField: 'permittype',
      buildingTypes: ['Building'],
      tradeByPattern: [['electrical', 'electrical'], ['mechanical', 'mechanical'], ['plumbing', 'plumbing']],
      job: { kind: 'masterField', field: 'pin' }, issued: 'issueddate',
      name: 'contractorcompanyname', phone: 'contractorphone', licence: 'contractorlicnum',
      rawTrade: 'contractortype', city: 'contractorcity', state: 'NC',
    },
    dateField: 'issueddate',
    orderByFields: 'issueddate DESC, OBJECTID',
    defaultState: 'NC',
    fieldMap: {
      permitNumber: 'permitnum',
      permitType: 'permittype',
      workDescription: 'proposedworkdescription',
      valuation: 'estprojectcost',
      status: 'statuscurrent',
      filedDate: 'issueddate',
      address: 'originaladdress1',
      city: 'originalcity',
      state: 'originalstate',
      zip: 'originalzip',
      parcelNumber: 'pin',
      owner: 'parcelownername',
      contractorName: 'contractorcompanyname',
      contractorPhone: 'contractorphone',
      contractorLicence: 'contractorlicnum',
      contractorTrade: 'contractortype',
      contractorCity: 'contractorcity',
    },
    // Seen in the first 30-day pull (2026-11-13).
    statusMap: { issued: 'issued', complete: 'issued', withdrawn: 'applied', 'ready for issuance': 'applied' },
  },

  // --- Not yet implemented -------------------------------------------------
  //
  // Clark County WA publishes a real ArcGIS feature layer — structurally the
  // cleanest of these sources. The 'arcgis' adapter is implemented and tested,
  // but this entry stays DISABLED until someone on a network that can reach
  // gis.clark.wa.gov reads the layer's real field names:
  //
  //   curl 'https://gis.clark.wa.gov/arcgisfed2/rest/services/MapsOnline/PermitSitePlansTemp/MapServer/9?f=json'
  //
  // Fill fieldMap/dateField from that response and uncomment. The adapter
  // throws rather than running without a fieldMap, so no guesses can leak in.
  // (The documented clark.wa.gov/community-planning/permits page 404s.)
  //
  // 'clark-county-wa': {
  //   label: 'Clark County, WA',
  //   type: 'arcgis',
  //   layerUrl: 'https://gis.clark.wa.gov/arcgisfed2/rest/services/MapsOnline/PermitSitePlansTemp/MapServer/9',
  //   dateField: '<VERIFY>',
  //   fieldMap: { address: '<VERIFY>', workDescription: '<VERIFY>', valuation: '<VERIFY>',
  //               status: '<VERIFY>', permitNumber: '<VERIFY>', filedDate: '<VERIFY>' },
  //   statusMap: { /* fill from the layer's real status vocabulary */ },
  // },
  //
  // 'washington-county-or' is DELIBERATELY NOT IMPLEMENTED. Its permit search
  // (https://webapps.washingtoncountyor.gov/bps/) is CAPTCHA-gated, which is an
  // explicit signal that automated access isn't permitted. Do not add a
  // scraper for it. The legitimate path is a bulk-data request or API access
  // arranged with the county.
};

// The markets the pilot runs on (docs/DECISIONS.md, ADR-9). These are what the
// scheduler and a bare `npm run ingest` refresh. Oregon and Portland stay
// available by naming them explicitly (ADR-5).
// Synced daily. City of Miami and Raleigh joined 2026-11-13 after a clean
// 30-day trial; the sales screens still show Austin and Miami-Dade only.
const PILOT_AREAS = ['austin-tx', 'miami-dade-fl', 'miami-city-fl', 'raleigh-nc'];

module.exports = { SOURCES, PILOT_AREAS };
