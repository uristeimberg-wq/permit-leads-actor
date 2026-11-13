// Records a small fixture of raw rows from a live source (CLAUDE.md rule 10),
// through the same adapter the sync uses, so the fixture has the exact shape
// ingest sees. Runs in GitHub Actions (fixture.yml): this container cannot
// reach government hosts.
//
// People's details are replaced before printing: owner, applicant and
// person-name fields become "REDACTED", emails become example.com addresses,
// and every phone becomes a 555 number. Business names and permit fields stay,
// because the fixture exists to test mapping and contractor resolution.
//
//   node recon/capture_fixture.js --source=austin-tx [--rows=20] [--days=14]
// Prints the fixture between BEGIN FIXTURE / END FIXTURE markers.

const { SOURCES } = require('../src/sources.js');
const { getAdapter } = require('../src/adapters/index.js');

const PERSON_FIELD = /owner|applicant|full_?name|first_?name|last_?name|contact_?name|agent/i;
const PHONE_FIELD = /phone|tel|fax|mobile/i;
const EMAIL_FIELD = /e_?mail/i;

/** A copy of one raw row with people's details replaced. Pure; tested. */
function redactRow(row) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(row)) {
    if (v == null || v === '') { out[k] = v; continue; }
    if (EMAIL_FIELD.test(k)) out[k] = 'redacted@example.com';
    else if (PHONE_FIELD.test(k)) { n += 1; out[k] = `512555${String(100 + n).padStart(4, '0')}`; }
    else if (PERSON_FIELD.test(k)) out[k] = 'REDACTED';
    else out[k] = v;
  }
  return out;
}

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

async function main() {
  const slug = arg('source');
  const source = SOURCES[slug];
  if (!source) throw new Error(`Unknown --source "${slug}". Known: ${Object.keys(SOURCES).join(', ')}`);
  const rows = Number(arg('rows', 20));
  const days = Number(arg('days', 14));
  let raw = [];
  const log = { info: () => {}, warning: (m) => console.error(`warning: ${m}`), error: (m) => console.error(m) };
  await getAdapter(source.type)(source, {
    includeIssued: true, daysBack: days, maxRecords: rows, log,
    onRaw: async (r) => { raw = r; },
  });
  if (!raw.length) throw new Error(`No rows from ${slug} in the last ${days} days`);
  const fixture = {
    source: slug, capturedAt: new Date().toISOString(), days, rows: raw.slice(0, rows).map(redactRow),
    fields: [...new Set(raw.flatMap((r) => Object.keys(r)))].sort(),
  };
  console.log('BEGIN FIXTURE');
  console.log(JSON.stringify(fixture));
  console.log('END FIXTURE');
}

if (require.main === module) {
  main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
}

module.exports = { redactRow };
