const assert = require('node:assert');
const { mapRecords, buildWorkDescription, parseDetailText, cleanValue, parseInspectionRow, HEADER_ALIASES } = require('./accela.js');
const { scorePermit } = require('../scoring.js');
const { toScorable } = require('../normalize.js');

function check(name, fn) {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}
function fakeLog() {
  const warnings = [];
  return { warnings, info: () => {}, warning: (m) => warnings.push(m) };
}

// Verbatim from a real Clackamas detail page saved during recon.
const REAL_DETAIL_TEXT = `
 Record B1096326 :
 Building - Residential New
 Record Status: Applicant Upload
 Record Details
 Project Description: Taking care of a people who has disability
 Owner: BERKA CHERU * 7300 SE SAN MARCOS AVE MILWAUKIE OR 97267
 More Details
 Additional Information
 Job Value($): $5,000.00
 Application Information
`;

// Verbatim from the real results grid.
const REAL_GRID_RECORD = {
  filedDate: '09/10/2026',
  permitNumber: 'B1096326',
  permitType: 'Building - Residential New',
  projectName: '',
  address: '7300 SE SAN MARCOS AVE, MILWAUKIE OR 97267',
  status: 'Applicant Upload',
  shortNotes: '',
  detailUrl: 'https://aca-prod.accela.com/CLACKAMAS/Cap/CapDetail.aspx?capID3=011D4',
};

const SOURCE = {
  label: 'Clackamas County, OR',
  statusMap: { issued: 'issued', 'applicant upload': 'applied', lobby: 'applied' },
};

check('parseDetailText pulls description and job value off a real detail page', () => {
  const { projectDescription, valuation } = parseDetailText(REAL_DETAIL_TEXT);
  assert.strictEqual(projectDescription, 'Taking care of a people who has disability');
  assert.strictEqual(valuation, 5000);
});

check('parseDetailText returns empty defaults when the fields are absent', () => {
  const { projectDescription, valuation } = parseDetailText('Record B1 : no details here');
  assert.strictEqual(projectDescription, '');
  assert.strictEqual(valuation, 0);
});

check('parseDetailText strips thousands separators and cents', () => {
  assert.strictEqual(parseDetailText('Job Value($): $1,250,000.50').valuation, 1250000.5);
});

check('parseDetailText works on unspaced textContent (collapsed panel regression)', () => {
  // fetchDetail reads textContent, not innerText, because Job Value sits in a
  // collapsed panel. textContent concatenates with little whitespace, so the
  // regexes must not depend on newlines.
  const packed = 'Record DetailsProject Description: Kitchen remodel with wall removalOwner: A B More DetailsAdditional InformationJob Value($): $82,500.00Application Information';
  const { projectDescription, valuation } = parseDetailText(packed);
  assert.strictEqual(valuation, 82500);
  assert.match(projectDescription, /Kitchen remodel with wall removal/);
});

check('a permit whose description does match the rules scores through the adapter', () => {
  // Guards that a zero score is a vocabulary gap, not the adapter dropping text.
  const rec = {
    ...REAL_GRID_RECORD,
    permitType: 'Building - Residential New',
    projectDescription: 'New SFR, two story',
    valuation: 400000,
    status: 'Applied',
  };
  const [permit] = mapRecords([rec], SOURCE, { log: fakeLog() });
  const { score } = scorePermit(permit, 'flooring');
  assert.strictEqual(score, 102); // 90 New construction + 12 applied
});

check('buildWorkDescription excludes permitType, which has its own field', () => {
  const desc = buildWorkDescription({
    permitType: 'Building - Residential New',
    projectName: 'Sandy Woods Lot 47',
    projectDescription: 'new single family dwelling',
  });
  assert.ok(!desc.includes('Building - Residential New'), 'permit type must not be duplicated into the description');
  assert.strictEqual(desc, 'Sandy Woods Lot 47 — new single family dwelling');
});

check('buildWorkDescription drops parts already contained in another part', () => {
  // Real Accela shape: projectName is a prefix of projectDescription.
  const desc = buildWorkDescription({
    projectName: '- TEMP-PLUMB-SSA-88796',
    projectDescription: '- TEMP-PLUMB-SSA-88796 Add new bathroom and relocate a lavatory',
  });
  assert.strictEqual(desc, '- TEMP-PLUMB-SSA-88796 Add new bathroom and relocate a lavatory');
});

check('buildWorkDescription collapses identical parts to one', () => {
  assert.strictEqual(buildWorkDescription({ projectName: 'BACKFLOW', projectDescription: 'BACKFLOW' }), 'BACKFLOW');
});

check('buildWorkDescription omits empty parts rather than leaving separators', () => {
  assert.strictEqual(buildWorkDescription({ projectDescription: 'Reroof' }), 'Reroof');
  assert.strictEqual(buildWorkDescription({}), '');
});

check('mapRecords maps a real grid+detail record into a scorable permit', () => {
  const rec = { ...REAL_GRID_RECORD, ...parseDetailText(REAL_DETAIL_TEXT) };
  const [permit] = mapRecords([rec], SOURCE, { log: fakeLog() });

  assert.strictEqual(permit.permitNumber, 'B1096326');
  assert.strictEqual(permit.address, '7300 SE SAN MARCOS AVE, MILWAUKIE OR 97267');
  assert.strictEqual(permit.valuation, 5000);
  assert.strictEqual(permit.status, 'applied'); // 'Applicant Upload' via statusMap
  assert.strictEqual(permit.filedDate, '2026-09-10'); // normalized off MM/DD/YYYY

  // permitType is its own field, not folded into the description.
  assert.strictEqual(permit.permitType, 'Building - Residential New');
  assert.ok(!permit.workDescription.includes('Building - Residential New'));

  // Place fields parsed from the address string.
  assert.strictEqual(permit.zip, '97267');
  assert.strictEqual(permit.city, 'MILWAUKIE');
  assert.strictEqual(permit.state, 'OR');
});

check('jurisdiction comes from the Agency column, falling back to the source label', () => {
  const [fromAgency] = mapRecords([{ ...REAL_GRID_RECORD, agency: 'YAMHILL_CO' }], SOURCE, { log: fakeLog() });
  assert.strictEqual(fromAgency.jurisdiction, 'YAMHILL_CO');

  // Clackamas' grid has no Agency column at all.
  const [fallback] = mapRecords([REAL_GRID_RECORD], SOURCE, { log: fakeLog() });
  assert.strictEqual(fallback.jurisdiction, 'Clackamas County, OR');
});

check('Accela statuses map through instead of silently losing the timing bonus', () => {
  const recs = [
    { ...REAL_GRID_RECORD, status: 'Issued' },
    { ...REAL_GRID_RECORD, status: 'Lobby' },
  ];
  const permits = mapRecords(recs, SOURCE, { log: fakeLog() });
  assert.deepStrictEqual(permits.map((p) => p.status), ['issued', 'applied']);
});

check('an unrecognized Accela status is reported for statusMap follow-up', () => {
  const log = fakeLog();
  mapRecords([{ ...REAL_GRID_RECORD, status: 'Plan Check' }], SOURCE, { log });
  assert.strictEqual(log.warnings.length, 1);
  assert.match(log.warnings[0], /"plan check" x1/);
});

check('includeIssued=false drops issued permits', () => {
  const recs = [
    { ...REAL_GRID_RECORD, status: 'Issued' },
    { ...REAL_GRID_RECORD, status: 'Lobby' },
  ];
  const permits = mapRecords(recs, SOURCE, { includeIssued: false, log: fakeLog() });
  assert.strictEqual(permits.length, 1);
  assert.strictEqual(permits[0].status, 'applied');
});

check('toScorable feeds permitType back into scoring, so demolition is filtered', () => {
  // permitType no longer lives in workDescription, so scoring only sees it via
  // toScorable(). Without that, a demolition permit would slip past the filter.
  const rec = { ...REAL_GRID_RECORD, permitType: 'Building - Demolition', projectDescription: 'Interior remodel', status: 'Issued' };
  const [permit] = mapRecords([rec], SOURCE, { log: fakeLog() });

  assert.match(toScorable(permit).workDescription, /Building - Demolition/);
  assert.strictEqual(scorePermit(toScorable(permit), 'flooring').score, 0, 'demolition must be filtered out');
});

check('header aliases cover both live ACA instances', () => {
  // Verified live: Clackamas and Oregon statewide label the same columns
  // differently. Dropping either spelling silently blanks that field.
  const clackamas = ['date', 'permit number', 'permit type', 'project name', 'address', 'status', 'short notes'];
  const oregon = ['opened', 'permit/application number', 'permit type', 'address', 'status'];

  const covered = new Set(Object.values(HEADER_ALIASES).flat());
  for (const header of [...clackamas, ...oregon]) {
    assert.ok(covered.has(header), `no alias covers the live header "${header}"`);
  }
  assert.ok(HEADER_ALIASES.filedDate.includes('opened'), 'Oregon files its date under "Opened"');
  assert.ok(HEADER_ALIASES.permitNumber.includes('permit/application number'));
});

check('parseDetailText pulls owner, parcel and construction type (free fields)', () => {
  // Verbatim shape from a real Clackamas detail page. These sit on the page we
  // already fetch, so capturing them costs no extra requests.
  const real = 'Record Details Project Description: Kitchen remodel Owner: BERKA CHERU * 7300 SE SAN MARCOS AVE '
    + 'MILWAUKIE OR 97267 1) Cheru Berka More Details Additional Information Job Value($): $5,000.00 '
    + 'Parcel Information Parcel Number:00461155 * Block:-- Lot:22E08AC05605 Subdivision:-- Fees Loading... '
    + 'Application Information GENERAL Construction Type: Other Other Construction Type: Change of use Jurisdiction: Clackamas County';
  const d = parseDetailText(real);

  assert.strictEqual(d.owner, 'BERKA CHERU');       // name only, not their mailing address
  assert.strictEqual(d.parcelNumber, '00461155');   // Accela's " *" primary marker stripped
  assert.strictEqual(d.parcelLot, '22E08AC05605');
  assert.strictEqual(d.constructionType, 'Other');
  assert.strictEqual(d.otherConstructionType, 'Change of use');
});

check('an Accela "--" placeholder is stored as absent, not as literal "--"', () => {
  const d = parseDetailText('Parcel Number:00461155 * Block:-- Lot:22E08AC05605 Subdivision:-- Fees');
  assert.strictEqual(d.parcelBlock, null);
  assert.strictEqual(d.parcelSubdivision, null);
  assert.strictEqual(cleanValue('--'), null);
  assert.strictEqual(cleanValue('N/A'), null);
  assert.strictEqual(cleanValue('  real value  '), 'real value');
});

check('mapRecords carries status stage and detail fields onto the permit', () => {
  const rec = {
    ...REAL_GRID_RECORD,
    status: 'Finaled',
    owner: 'BERKA CHERU',
    parcelNumber: '00461155',
    constructionType: 'Other',
  };
  const [permit] = mapRecords([rec], SOURCE, { log: fakeLog() });

  // The distinction that matters: a finished job must not read as approved.
  assert.strictEqual(permit.statusRaw, 'Finaled');
  assert.strictEqual(permit.statusStage, 'finished');
  assert.strictEqual(permit.owner, 'BERKA CHERU');
  assert.strictEqual(permit.parcelNumber, '00461155');
  assert.strictEqual(permit.constructionType, 'Other');
});

check('a construction type stops at the next label instead of running on', () => {
  // Live regression: without 'Permit Expiration' in the stop list this stored
  // "Addition/alteration of existing structure Permit Expiration: 03/09/2027".
  const real = 'GENERAL Construction Type: Addition/alteration of existing structure '
    + 'Permit Expiration: 03/09/2027 Jurisdiction: Clackamas County Insp Area: EAST';
  assert.strictEqual(parseDetailText(real).constructionType, 'Addition/alteration of existing structure');
});

check('a completed inspection parses its result, type, inspector and date', () => {
  const row = parseInspectionRow('Approved\n199 Electrical Final\nResult by: DD on 09/11/2026\nView Details', 'completed');
  assert.deepStrictEqual(row, {
    status: 'completed', type: '199 Electrical Final',
    date: '09/11/2026', result: 'Approved', inspector: 'DD',
  });
});

check('a scheduled inspection does not put its date in the result field', () => {
  // Live regression: the scheduled grid renders differently from the completed
  // one, and reading it with the completed layout stored result="09/16/2026".
  const row = parseInspectionRow('09/16/2026\nScheduled 120 Rough-in/Cover/Ditch Cover\nView Details', 'scheduled');
  assert.strictEqual(row.result, null, 'a scheduled inspection has no result yet');
  assert.strictEqual(row.date, '09/16/2026');
  assert.strictEqual(row.type, '120 Rough-in/Cover/Ditch Cover'); // "Scheduled " prefix dropped
});

check('an inspection row with nothing useful yields null or no type', () => {
  assert.strictEqual(parseInspectionRow('', 'completed'), null);
  assert.strictEqual(parseInspectionRow('View Details', 'completed'), null);
});

check('"Owner" is not matched inside "Homeowners"', () => {
  // Live regression from the 2026-09-25 Oregon ingest: the ePermitting detail
  // page carries site navigation in its text, and `Owner` matched inside
  // "Homeowners Register for Oregon ePermitting...". With nothing after it to
  // stop on, the capture ran to the end of the page and ~1,500 characters of
  // menu text were stored as the permit's owner.
  const navText = 'Homeowners Register for Oregon ePermitting Apply for Building Permit '
    + 'Easy Inspection Scheduling Training: Online Building Permit Application Process';
  const detail = parseDetailText(navText);
  assert.strictEqual(detail.owner, null, 'nav text must not be read as an owner');
});

check('a real owner is still read, and trimmed at the mailing address', () => {
  const detail = parseDetailText('Owner: BERKA CHERU * 7300 SE SAN MARCOS AVE Job Value($): $1,200');
  assert.strictEqual(detail.owner, 'BERKA CHERU');
  assert.strictEqual(detail.valuation, 1200);
});

check('a run-on capture is dropped rather than stored', () => {
  // The stop list cannot anticipate every page variant, so length is the
  // backstop: these fields are names and codes, never paragraphs.
  const detail = parseDetailText(`Owner: ${'X'.repeat(400)}`);
  assert.strictEqual(detail.owner, null);
});

console.log('\nDone.');
