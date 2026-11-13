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
    // --max=6000 failed live; ~1,500 is the tested-safe ceiling (see README).
    maxPerRun: 1500,
    dateField: 'PermitIssuedDate',
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
const PILOT_AREAS = ['austin-tx', 'miami-dade-fl'];

module.exports = { SOURCES, PILOT_AREAS };
