// One entry per supported area. Each entry declares a `type`, which selects the
// adapter in src/adapters/ that knows how to read it. Adding coverage means
// adding an entry here plus (if it's a new kind of portal) an adapter.
//
// These jurisdictions do NOT share a data format — see the notes on each.

// Status words of Austin's AMANDA planning cases (site plans, subdivisions),
// read live 2026-11-14. Unmapped on purpose, so they report as unknown:
// 'closed', 'inactive', 'suspended', 'admin hold', 'vacated', 'review
// completed', 'intake rejected', 'cc rejected' (none says the stage plainly).
// "CC" is the completeness check at intake.
const AUSTIN_CASE_STATUSES = {
  pending: 'submitted', 'intake pending': 'submitted', 'internet pending': 'submitted',
  'intake accepted - fees due': 'submitted', 'formal intake accepted - fees due': 'submitted',
  'cc pending': 'in_review', 'cc pending - fees paid': 'in_review', 'cc approved': 'in_review',
  'in review': 'in_review', 'waiting on legal': 'in_review', 'waiting on fiscal': 'in_review',
  'scheduled for hearing': 'in_review', 'tolling - hearing pending': 'in_review',
  'awaiting update': 'corrections', 'application incomplete': 'corrections',
  approved: 'approved', 'approved and released': 'approved', 'awaiting recordation': 'approved',
  'subdivision recorded': 'completed',
  expired: 'expired', withdrawn: 'withdrawn', aborted: 'withdrawn', void: 'cancelled', cancelled: 'cancelled', denied: 'denied',
};

// Raleigh plan statuses on both plan layers (read 2026-11-14). 'active'
// (most pre-2020 plans), 'review complete', 'on hold', 'pending' and
// 'disposed' stay unmapped: none says the stage plainly.
// DERM sewer certification codes (SWRAPVCODE, probe 2026-11-14: APP 1,238,
// COALLOC 493, CODEALALLOC 213, DEAL 25, BPEXP 11, DEN 8, EXP 2, WITHDRAWN 1
// in a year). COALLOC, CODEALALLOC and DEAL are allocation bookkeeping whose
// meaning the county does not publish, so they stay unknown (rule 3).
const DERM_SEWER_STATUSES = {
  pen: 'submitted', app: 'approved', den: 'denied', exp: 'expired', bpexp: 'expired', withdrawn: 'withdrawn',
};

const RALEIGH_PLAN_STATUSES = {
  submitted: 'submitted', 'submitted - online': 'submitted',
  'in review': 'in_review', 'review in progress': 'in_review',
  approved: 'approved', 'in appeal period': 'approved', 'ready for issuance': 'approved',
  'approval expired': 'expired', 'review expired': 'expired', denied: 'denied',
};

// Raleigh plan types -> case kind. 'special use' is a zoning permit; 'master
// plan' a development plan; the rest are site or subdivision plans.
const RALEIGH_PLAN_KINDS = {
  'dslc - administrative site review [asr]': 'site_plan', 'administrative site review': 'site_plan',
  'dslc - site permitting review': 'site_plan', 'site plan': 'site_plan', 'plan approval': 'site_plan',
  'group housing': 'site_plan', 'shopping center': 'site_plan', 'mobile home park': 'site_plan',
  'dslc - preliminary subdivision': 'subdivision', subdivision: 'subdivision', 'minor subdivision': 'subdivision',
  'infill recombination': 'subdivision', 'special use': 'zoning', 'master plan': 'development_plan',
};

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
    // Pilot screens (db/pilot_queries.js sourceMeta). Measured 2026-11-13.
    // `early`: the feeds whose not-yet-issued filings the Early screen lists.
    display: { city: 'Austin', publicationLag: 'Austin publishes permits 2-3 days after issue', jobLink: 'the same base permit number', early: ['austin-plan-review-tx'],
      earlyLag: 'Plan-review cases are published the same day they are applied for' },
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
    // Rolling re-read (ingest/refresh.js, migration 030): stored permits
    // re-fetched by number per run, 50 per request. Austin's store is the
    // largest, so it gets the most.
    refreshPerRun: 10000,
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
      submittedDate: 'applieddate',
      statusDate: 'statusdate',
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
    // Canonical lifecycle stage (src/lifecycle.js, ADR-16). 'pending' and
    // 'on hold' stay unmapped: on an issued-permits feed neither says which
    // stage the permit is in, so they are reported as unknown.
    lifecycle: {
      statuses: {
        active: 'issued', final: 'completed', closed: 'completed',
        expired: 'expired', 'expired - license': 'expired',
        void: 'cancelled', cancelled: 'cancelled', 'cancelled - contractor required': 'cancelled',
        withdrawn: 'withdrawn', aborted: 'withdrawn',
        'inactive pending revision': 'corrections', 'pending permit': 'approved',
      },
    },
  },

  // Austin Plan Review Cases (n8ck-xkda): building applications from intake
  // to approval, before the permit in 3syk-w9eu exists (ADR-16 E1). Fields
  // read live 2026-11-13 (fixture austin-plan-review-tx.json). The issued
  // permit's masterpermitnum equals the case's folderrsn (ingest/link_filings.js).
  // No contractor at this stage: applicants are builders, owners and permit
  // expediters, and individual names are never shown (rule 5), so no party
  // columns are mapped. No city or zip columns; project_name is the address.
  'austin-plan-review-tx': {
    label: 'Austin, TX (plan review)',
    type: 'socrata',
    domain: 'datahub.austintexas.gov',
    datasetId: 'n8ck-xkda',
    filingKind: 'building_application',
    // project_name is sometimes a project title, not an address.
    addressMustStartWithNumber: true,
    // New cases by applied date, status changes by status date (intra-day
    // publication, read 2026-11-13).
    syncWindows: [
      { field: 'applied_date', days: 30 },
      { field: 'status_date', days: 14 },
    ],
    maxPerRun: 25000,
    backfillMaxPerRun: 100000,
    maxDataAgeDays: 4,
    registry: {
      jurisdiction: 'austin-tx', syncMode: 'date_window', expectedInterval: '1 day',
      terms: { url: 'https://data.austintexas.gov/stories/s/City-of-Austin-Open-Data-Terms-of-Use/ranj-cccq/', reviewedOn: '2026-11-13', automatedAccess: 'unknown', redistribution: 'yes' },
      fixture: 'test/fixtures/sources/austin-plan-review-tx.json',
    },
    // GeoJSON point [lng, lat].
    coordinates: { point: 'location' },
    dateField: 'applied_date',
    defaultState: 'TX',
    fieldMap: {
      permitNumber: 'permit_number',
      permitType: 'sub_type',
      workDescription: 'folder_description',
      valuation: ['total_job_valuation', 'total_valuation_remodel', 'building_valuation_remodel',
        'electrical_valuation_remodel', 'mechanical_valuation_remodel', 'plumbing_valuation_remodel'],
      status: 'status_current',
      filedDate: 'applied_date',
      submittedDate: 'applied_date',
      statusDate: 'status_date',
      permitUrl: 'web_link',
      address: 'project_name',
    },
    // Scoring's applied/issued bucket: nothing here is issued.
    statusMap: {
      pending: 'applied', 'intake pending': 'applied', 'application incomplete': 'applied', 'in review': 'applied',
      'prerequisite review approved': 'applied', 'awaiting update': 'applied', approved: 'applied',
      void: 'applied', aborted: 'applied', expired: 'applied', withdrawn: 'applied', denied: 'applied',
      'approved and released': 'applied', 'in e-review': 'applied', 'e-prerequisite review pending': 'applied',
      'awaiting update - fee paid': 'applied', 'awaiting update - fees due': 'applied', 'revision submitted': 'applied',
    },
    // "Approved" here means the plans are approved; the permit is not issued,
    // so status_stage (src/status.js) keeps it pending.
    statusStages: { approved: 'pending', 'approved and released': 'pending' },
    lifecycle: {
      statuses: {
        pending: 'submitted', 'intake pending': 'submitted',
        'application incomplete': 'corrections', 'awaiting update': 'corrections',
        'in review': 'in_review', 'prerequisite review approved': 'in_review',
        approved: 'approved', void: 'cancelled', aborted: 'withdrawn',
        expired: 'expired', withdrawn: 'withdrawn', denied: 'denied',
        // Seen in the first production sync (2026-11-13). 'New Application
        // Required', 'Awaiting Upload', 'Queue' and 'Intake Rejected' stay
        // unmapped: none says the stage plainly.
        'approved and released': 'approved', 'in e-review': 'in_review', 'e-prerequisite review pending': 'in_review',
        'revision submitted': 'in_review', 'awaiting update - fee paid': 'corrections', 'awaiting update - fees due': 'corrections',
      },
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
    // Issued permits only: no early filings to list.
    display: { city: 'Miami-Dade', publicationLag: 'Miami-Dade refreshes this layer weekly', jobLink: 'the master permit number', early: [] },
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
      // The design professional of record (lane C, contractors-v5). 99.9%
      // filled, but 86% is the placeholder "NOT LISTED" and most real values
      // are a person's name; only firms are shown (rule 5). Profile from the
      // live layer, 2026-11-14: recon/identity_recon.js --architects.
      architect: 'ArchitectName',
    },
    dateField: 'PermitIssuedDate',
    // No status column: the stage comes from deriveStatus below.
    lifecycle: { derived: true },
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
    // Issued permits only (PR #43 scan); the layer has no contractor phone.
    display: { city: 'City of Miami', publicationLag: 'The City of Miami edits this layer daily', jobLink: 'the application number', early: [] },
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
    // New permits by issue date, and status changes by Statusdate: the
    // fidelity check (2026-11-14) found the City moving old permits from
    // "Active" to "Final" with a new Statusdate, outside the issue window.
    syncWindows: [
      { field: 'IssuedDate', days: 14 },
      { field: 'Statusdate', days: 14 },
    ],
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
    lifecycle: { statuses: { active: 'issued', final: 'completed', revoked: 'cancelled' } },
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
    display: { city: 'Raleigh', publicationLag: 'Raleigh updates its layers daily; new filings appear about 2 days after application', jobLink: 'the parcel (PIN)', early: ['raleigh-nc'],
      earlyLag: 'New filings appear about 2 days after application' },
    type: 'arcgis',
    layerUrls: [
      'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Building_Permits/FeatureServer/0',
      'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Permits_Other_Than_Buildings/FeatureServer/0',
    ],
    // Windows (ADR-16 E2): new filings by their own date, issues, and changes.
    // Not issueddate alone, which hid the 73% of new building filings still in
    // review. Counts read 2026-11-13 (recon/feasibility.js raleighWindows):
    //   building: applieddate 30d 459 (335 not issued), recordupdatedate 14d 1,843
    //   trade: CreationDate 30d 2,406 (1,028 not issued), issueddate 30d 1,810,
    //          recordupdatedate 14d 3,460. EditDate moves ~1,000 rows a day, so
    //          recordupdatedate is the change signal on both layers.
    // The trade layer has no applieddate; CreationDate is when its row was
    // created, used only to find new rows, never stored as a filing date.
    syncWindows: [
      { field: 'applieddate', days: 30, layer: 0 },
      { field: 'CreationDate', days: 30, layer: 1 },
      { field: 'issueddate', days: 30 },
      { field: 'recordupdatedate', days: 14 },
    ],
    // The limit is per layer; the trade layer's windows overlap to well under
    // 8,000 rows. A layer at the limit trips the run's truncation alarm.
    maxPerRun: 10000,
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
      // On 92.3% of the newest 2,000 raw rows (data audit 2026-11-14).
      email: 'contractoremail',
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
      // The issue date, as in every pilot market: the lead screens and the
      // health check read filed_date as one. The filing date is submitted_on;
      // an unissued filing has filed_date NULL and is listed by the Early screen.
      filedDate: 'issueddate',
      submittedDate: 'applieddate',
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
    statusMap: {
      issued: 'issued', complete: 'issued', withdrawn: 'applied', 'ready for issuance': 'applied',
      'submitted - online': 'applied', submitted: 'applied', 'in review': 'applied', 'delayed issuance': 'applied',
    },
    // 'delayed issuance' and 'on hold' stay unmapped: neither says the stage.
    lifecycle: {
      statuses: {
        issued: 'issued', complete: 'completed', withdrawn: 'withdrawn', 'ready for issuance': 'approved',
        'submitted - online': 'submitted', submitted: 'submitted', 'in review': 'in_review',
      },
    },
  },

  // --- Planning cases (pre-application signals) ----------------------------
  //
  // kind 'planning': these write planning_cases (migration 025,
  // src/planning.js), never permits, and the lead screens never read them.
  // Every column below was read live on 2026-11-14 (recon/planning_probe.js,
  // feasibility.yml input `planning`; fixtures in test/fixtures/sources/).
  // fieldMap holds only what the adapters and raw_records need: the case key
  // and the window date. No maxDataAgeDays: the health check's "newest permit"
  // test does not apply; sync failures still alarm through source_health.

  // Austin Site Plan Cases (mavg-96ck): site plans from intake, months to a
  // year before the building permit for apartments and commercial (P0
  // backtest). 44 applied in the 30 days to 2026-11-14; status changes 485 in
  // 30 days. update_date is rewritten on every row daily, so it is no window.
  // Public Domain (dataset licence). The case is keyed by folderrsn (100%);
  // the human case number (permit_number, 84%) is case_ref.
  'austin-site-plans-tx': {
    label: 'Austin, TX (site plans)',
    kind: 'planning',
    type: 'socrata',
    domain: 'datahub.austintexas.gov',
    datasetId: 'mavg-96ck',
    syncWindows: [
      { field: 'application_start_date', days: 30 },
      { field: 'status_date', days: 14 },
    ],
    maxPerRun: 5000,
    backfillMaxPerRun: 30000,
    registry: {
      jurisdiction: 'austin-tx', syncMode: 'date_window', expectedInterval: '1 day',
      terms: { url: 'https://data.austintexas.gov/stories/s/City-of-Austin-Open-Data-Terms-of-Use/ranj-cccq/', licenceTag: 'Public Domain', reviewedOn: '2026-11-14', automatedAccess: 'unknown', redistribution: 'yes' },
      fixture: 'test/fixtures/sources/austin-site-plans-tx.json',
    },
    dateField: 'application_start_date',
    defaultState: 'TX',
    fieldMap: { permitNumber: 'folderrsn', filedDate: 'application_start_date' },
    planning: {
      caseKind: 'site_plan',
      fields: {
        caseNumber: 'folderrsn', caseRef: 'permit_number', caseType: 'sub_type', status: 'status',
        filedOn: 'application_start_date', statusDate: 'status_date', decidedOn: 'approval_date',
        name: 'case_name', description: 'description_of_work', parcel: 'tcad_id', propertyRef: 'propertyrsn',
        zoning: 'existing_zoning', unitsProposed: 'proposed_no_of_units', floorAreaSqft: 'proposed_bldg_sq_footage',
        acreage: 'gross_site_area_acres', lat: 'latitude', lng: 'longitude', recordUrl: 'link',
      },
      addressParts: ['street_number', 'street_prefix', 'street_name', 'street_type', 'street_direction'],
      // Organisations only; the applicant and owner full names are people
      // and are not stored (rule 5).
      parties: [{ role: 'applicant', field: 'applicant_organization_name' }, { role: 'owner', field: 'owner_organization_name' }],
      // 81 of the newest 200 site plans share a propertyrsn with a plan-review
      // case (probe 2026-11-14). Same property, not the same project: inferred.
      // Hand check 2026-11-14 (recon/planning_checks.js austin-site): of 30
      // linked pairs read side by side, 18 were the same project, 9 a
      // different job on the same lot, 3 unclear. Confidence = 18/30.
      links: [{ kind: 'parcel_window', to: 'austin-plan-review-tx', caseColumn: 'property_ref', permitField: 'propertyrsn',
        days: 1095, confidence: 0.6, detail: 'plan review propertyrsn = site plan propertyrsn, filed within 3 years after',
        measured: { checkedOn: '2026-11-14', read: 30, same: 18, different: 9, unclear: 3 } }],
    },
    lifecycle: { statuses: AUSTIN_CASE_STATUSES },
  },

  // Austin Subdivision Cases (s7gx-9m54): preliminary plans, final plats and
  // construction plans, often a year or more before homes. 20 applied in 30
  // days; 147 status changes. Keyed by projectid (100%); permitnum is the
  // human case number. Lots proposed on 87% of the newest rows.
  'austin-subdivisions-tx': {
    label: 'Austin, TX (subdivisions)',
    kind: 'planning',
    type: 'socrata',
    domain: 'datahub.austintexas.gov',
    datasetId: 's7gx-9m54',
    syncWindows: [
      { field: 'application_start_date', days: 30 },
      { field: 'status_date', days: 14 },
    ],
    maxPerRun: 5000,
    backfillMaxPerRun: 20000,
    registry: {
      jurisdiction: 'austin-tx', syncMode: 'date_window', expectedInterval: '1 day',
      terms: { url: 'https://data.austintexas.gov/stories/s/City-of-Austin-Open-Data-Terms-of-Use/ranj-cccq/', licenceTag: 'Public Domain', reviewedOn: '2026-11-14', automatedAccess: 'unknown', redistribution: 'yes' },
      fixture: 'test/fixtures/sources/austin-subdivisions-tx.json',
    },
    dateField: 'application_start_date',
    defaultState: 'TX',
    fieldMap: { permitNumber: 'projectid', filedDate: 'application_start_date' },
    planning: {
      caseKind: 'subdivision',
      fields: {
        caseNumber: 'projectid', caseRef: 'permitnum', caseType: 'sub_type', status: 'status',
        filedOn: 'application_start_date', statusDate: 'status_date', decidedOn: 'approval_date',
        name: 'case_name', description: ['desc_of_proposed_development', 'description_of_work'],
        parcel: 'tcad_id', propertyRef: 'propertyrsn', zoning: 'existing_zoning',
        lotsProposed: 'proposed_no_of_lots', unitsProposed: 'proposed_no_of_units', floorAreaSqft: 'proposed_bldg_sq_footage',
        acreage: 'gross_site_area_acres', lat: 'latitude', lng: 'longitude', recordUrl: 'link',
      },
      addressParts: ['street_number', 'street_prefix', 'street_name', 'street_type', 'street_direction'],
      parties: [{ role: 'applicant', field: 'applicant_organization_name' }, { role: 'owner', field: 'owner_organization_name' }],
      // 43 of the newest 200 share a propertyrsn with a plan-review case.
      // Off after the hand check 2026-11-14 (austin-subdiv): houses are filed
      // on their own new lot ids, so the subdivision's propertyrsn almost
      // never reappears (2 of 724 house cases on 20 recorded subdivisions).
      links: [{ kind: 'parcel_window', to: 'austin-plan-review-tx', caseColumn: 'property_ref', permitField: 'propertyrsn',
        days: 1095, confidence: 0.5, detail: 'plan review propertyrsn = subdivision propertyrsn, filed within 3 years after',
        enabled: false, offReason: 'houses are filed on new lot ids: 2 of 724 matched (hand check 2026-11-14)',
        measured: { checkedOn: '2026-11-14', read: 724, same: 2 } }],
    },
    lifecycle: { statuses: AUSTIN_CASE_STATUSES },
  },

  // Raleigh Development Plan Areas: every plan in the City's EnerGov system
  // (site reviews, preliminary subdivisions, site permitting reviews), with
  // the main parcel PIN (99.4%) and a description. 33 applied in the 30 days
  // to 2026-11-14; 357 changed. Item licence blank; same org and Open Raleigh
  // Data Policy as our permit layers, so the same stop-on-request rule.
  'raleigh-plan-areas-nc': {
    label: 'Raleigh, NC (development plans)',
    kind: 'planning',
    type: 'arcgis',
    layerUrl: 'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Development_Plan_Areas/FeatureServer/0',
    syncWindows: [
      { field: 'apply_date', days: 30 },
      { field: 'lastchangedon', days: 14 },
    ],
    orderByFields: 'apply_date DESC, OBJECTID',
    maxPerRun: 3000,
    backfillMaxPerRun: 15000,
    registry: {
      jurisdiction: 'raleigh-nc', syncMode: 'date_window', expectedInterval: '1 day',
      terms: { url: null, reviewedOn: '2026-11-14', automatedAccess: 'unknown', redistribution: 'unknown' },
      fixture: 'test/fixtures/sources/raleigh-plan-areas-nc.json',
    },
    dateField: 'apply_date',
    defaultState: 'NC',
    fieldMap: { permitNumber: 'plan_number', filedDate: 'apply_date' },
    planning: {
      caseKinds: RALEIGH_PLAN_KINDS,
      fields: {
        caseNumber: 'plan_number', caseType: 'plan_type', status: 'plan_status', filedOn: 'apply_date',
        expiresOn: 'expire_date', name: 'project', description: 'description', address: 'main_address_line1',
        parcel: 'main_parcel_number', floorAreaSqft: 'square_feet',
      },
      // Building permits name the parcel PIN; devplanid is not a key of either
      // plan layer (integer vs GUID plplanid, probe 2026-11-14), so the link is
      // by parcel and time only.
      // Hand check 2026-11-14 (raleigh): any later permit on the PIN was the
      // plan's project in only 8 of 30 pairs (11 different, 11 unclear); many
      // plans are minor site reviews. Restricted to new-construction permits
      // (workclassmapped = New, 789 of 3,112 link rows) the same check read 30
      // evenly sampled pairs: 24 same, 4 different, 2 unclear. Many first
      // "new" permits are accessory structures (dumpster pads, enclosures) of
      // the right project, so the link says "same site", not "the building".
      links: [{ kind: 'parcel_window', to: 'raleigh-nc', caseColumn: 'parcel_id', permitField: 'pin',
        permitFilter: { field: 'workclassmapped', equals: 'New' },
        days: 1095, confidence: 0.8, detail: 'permit pin = plan main_parcel_number, new-construction permit filed within 3 years after',
        measured: { checkedOn: '2026-11-14', read: 30, same: 24, different: 4, unclear: 2, anyPermit: { read: 30, same: 8 } } }],
    },
    lifecycle: { statuses: RALEIGH_PLAN_STATUSES },
  },

  // Raleigh Development Plans: the same plans by plan_number, with what the
  // areas layer lacks: the developer (as published; often the engineer),
  // lots, units and square feet requested and approved, zoning and acreage.
  // 13 submitted in 30 days, 129 updated. 5.7% of developer names read as a
  // person's: stored, never shown (rule 5).
  'raleigh-devplans-nc': {
    label: 'Raleigh, NC (development plan details)',
    kind: 'planning',
    type: 'arcgis',
    layerUrl: 'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Development_Plans/FeatureServer/0',
    syncWindows: [
      { field: 'submitted', days: 30 },
      { field: 'updated', days: 14 },
    ],
    orderByFields: 'submitted DESC, OBJECTID',
    maxPerRun: 3000,
    backfillMaxPerRun: 10000,
    registry: {
      jurisdiction: 'raleigh-nc', syncMode: 'date_window', expectedInterval: '1 day',
      // Item licence field: the Open Raleigh Data Policy (read 2026-11-14).
      terms: { url: 'https://www.arcgis.com/home/item.html?id=0cded58c5048437d8da83608818650ba', reviewedOn: '2026-11-14', automatedAccess: 'unknown', redistribution: 'unknown' },
      fixture: 'test/fixtures/sources/raleigh-devplans-nc.json',
    },
    dateField: 'submitted',
    defaultState: 'NC',
    fieldMap: { permitNumber: 'plan_number', filedDate: 'submitted' },
    planning: {
      caseKinds: RALEIGH_PLAN_KINDS,
      fields: {
        caseNumber: 'plan_number', caseType: 'plan_type', status: 'status', filedOn: 'submitted',
        decidedOn: 'approved', expiresOn: 'sunset_date', name: 'plan_name', address: 'major_street',
        zoning: 'zoning', acreage: 'acreage', lotsProposed: 'lots_req', lotsApproved: 'lots_apprv',
        unitsProposed: 'units_req', unitsApproved: 'units_apprv', floorAreaSqft: 'sq_ft_req',
      },
      parties: [{ role: 'developer', field: 'developer' }],
    },
    lifecycle: { statuses: RALEIGH_PLAN_STATUSES },
  },

  // Miami-Dade DERM sewer capacity certifications (probe 2026-11-14). A
  // project must certify sewer capacity before the county issues its building
  // permit, and the certification names that permit's process number
  // (BLDPROCNO). Measured on 595 certifications: where the process number
  // matched an issued county permit (85), the permit came a median 33 days
  // later (p25 21, p75 77), never before; 510 had no issued permit yet. Miami
  // otherwise publishes issued permits only, so this is its earliest signal.
  'miami-derm-sewer-fl': {
    label: 'Miami-Dade, FL (DERM sewer certifications)',
    kind: 'planning',
    type: 'arcgis',
    layerUrl: 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/DERMSewerAllocation_gdb/FeatureServer/0',
    // The layer is edited about weekly. A certification's status changes
    // (approved -> expired or deallocated) are caught while it is within 60
    // days of certification, or by its deallocation date.
    syncWindows: [
      { field: 'SWRCRTDATE', days: 60 },
      { field: 'SWRDEALLDT', days: 30 },
    ],
    orderByFields: 'SWRCRTDATE DESC, OBJECTID',
    maxPerRun: 3000,
    backfillMaxPerRun: 15000,
    registry: {
      jurisdiction: 'miami-dade-county-fl', syncMode: 'date_window', expectedInterval: '1 day',
      // Same county terms as miami-dade-fl: no licence granted, so
      // redistribution is unknown until the lawyer answers.
      terms: { url: 'https://www.miamidade.gov/global/disclaimer/disclaimer.page', reviewedOn: '2026-11-14', automatedAccess: 'unknown', redistribution: 'unknown' },
      fixture: 'test/fixtures/sources/miami-derm-sewer-fl.json',
    },
    dateField: 'SWRCRTDATE',
    defaultState: 'FL',
    fieldMap: { permitNumber: 'EEOSALLCNO', filedDate: 'SWRCRTDATE' },
    planning: {
      caseKind: 'utility_allocation',
      // One allocation number covers a group of lots, one row per lot, often
      // each with its own process number (36 allocations in a year, a median
      // 4 lots; hand check 2026-11-14). Keyed by allocation number alone, all
      // but one lot was dropped. The case is the lot: allocation, folio and
      // address; the allocation number is the case_ref. An address the county
      // re-types makes a new case; the old one stops being seen (last_seen_at).
      caseNumberParts: ['EEOSALLCNO', 'FOLIO', 'ADDRESS'],
      fields: {
        // SWRCRTDATE is the certification date. The request date SWRRCTDATE is
        // on 0.2% of rows, so it is not used as the filing date.
        caseRef: 'EEOSALLCNO', status: 'SWRAPVCODE', filedOn: 'SWRCRTDATE', expiresOn: 'EXPDT90DAY',
        description: 'EEOSPRJDSC', address: 'ADDRESS', parcel: 'FOLIO', officialRef: 'BLDPROCNO',
        flowGpd: 'PRPDFLWGPD',
      },
      // BLDPROCNO "N/A" is a placeholder and stays NULL (src/planning.js).
      links: [{ kind: 'official', to: 'miami-dade-fl', caseColumn: 'official_ref', permitField: 'ProcessNumber',
        detail: 'permit ProcessNumber = certification BLDPROCNO' }],
    },
    lifecycle: { statuses: DERM_SEWER_STATUSES },
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
// Austin plan review joined 2026-11-13 (ADR-16 E1): applications, not leads, so
// the lead screens never list it (db/pilot_queries.js filters by source).
// Planning cases joined 2026-11-14 (kind 'planning', migration 025): they
// write planning_cases, never permits, so no lead screen lists them.
const PILOT_AREAS = ['austin-tx', 'austin-plan-review-tx', 'miami-dade-fl', 'miami-city-fl', 'raleigh-nc',
  'austin-site-plans-tx', 'austin-subdivisions-tx', 'raleigh-plan-areas-nc', 'raleigh-devplans-nc', 'miami-derm-sewer-fl'];

module.exports = { SOURCES, PILOT_AREAS };
