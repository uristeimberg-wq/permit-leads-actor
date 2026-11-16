// The public market pages (/markets/<state>/<city>, ADR-42).
//
// One entry per market we sync. Only these four exist: a page for a city we
// hold no records for would be invented coverage (hard rule 1), and a page
// per ZIP or per contractor would be thin programmatic pages.
//
// `permits`: the sources whose filed_date is the issue date of a permit
// (src/sources.js maps issue_date, PermitIssuedDate, IssuedDate, issueddate).
// `applications`: the sources that publish building applications before
// issue, with the column that holds the application date for that source:
//   austin-plan-review-tx  filed_date = applied_date (filing_kind building_application)
//   raleigh-nc             submitted_on = applieddate
// Miami-Dade and the City of Miami publish no application date, so their
// pages say "not published" instead of showing a zero.

const MARKETS = [
  {
    state: 'tx', city: 'austin', name: 'Austin', stateName: 'Texas', stateCode: 'TX',
    publisher: 'City of Austin',
    permits: ['austin-tx'],
    applications: [{ source: 'austin-plan-review-tx', dateColumn: 'filed_date' }],
    appAreas: 'a:TX',
    scope: 'Permits and plan-review cases published by the City of Austin on its open data portal (data.austintexas.gov).',
  },
  {
    state: 'fl', city: 'miami-dade', name: 'Miami-Dade County', stateName: 'Florida', stateCode: 'FL',
    publisher: 'Miami-Dade County',
    permits: ['miami-dade-fl'],
    applications: [],
    appAreas: 'a:FL',
    scope: 'Permits in the Miami-Dade County permit layer. The City of Miami publishes its own permits, which are counted on the City of Miami page, not here.',
  },
  {
    state: 'fl', city: 'miami', name: 'City of Miami', stateName: 'Florida', stateCode: 'FL',
    publisher: 'City of Miami',
    permits: ['miami-city-fl'],
    applications: [],
    appAreas: 'a:FL',
    scope: 'Building permits in the City of Miami\'s own permit layer (Building Permits Since 2014).',
  },
  {
    state: 'nc', city: 'raleigh', name: 'Raleigh', stateName: 'North Carolina', stateCode: 'NC',
    publisher: 'City of Raleigh',
    permits: ['raleigh-nc'],
    applications: [{ source: 'raleigh-nc', dateColumn: 'submitted_on' }],
    appAreas: 'a:NC',
    scope: 'Building permits and permits other than buildings published by the City of Raleigh.',
  },
];

const SLUG = /^[a-z]{2}$/;
const CITY = /^[a-z0-9-]{2,40}$/;

/** The market at /markets/<state>/<city>, or null. */
function findMarket(state, city) {
  const s = String(state || '').toLowerCase();
  const c = String(city || '').toLowerCase();
  if (!SLUG.test(s) || !CITY.test(c)) return null;
  return MARKETS.find((m) => m.state === s && m.city === c) || null;
}

const marketPath = (m) => `/markets/${m.state}/${m.city}`;

/** Every source a market reads, once. */
const marketSources = (m) => [...new Set([...m.permits, ...m.applications.map((a) => a.source)])];

module.exports = { MARKETS, findMarket, marketPath, marketSources };
