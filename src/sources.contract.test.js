// Connector contract (ADR-14). Every source that has a `registry` block (every
// source we run or plan to run) must pass these offline checks before it can
// be enabled. Adding a market = a config entry here + a recorded fixture
// (recon/capture_fixture.js via fixture.yml) + a migration row; see
// docs/CONNECTORS.md. No network, no DB.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SOURCES, PILOT_AREAS } = require('./sources.js');
const { EXTRACTORS } = require('./contractors.js');
const { mapRows } = require('./adapters/socrata.js');
const { mapFeatures } = require('./adapters/arcgis.js');
const { mappedFields } = require('../ingest/drift.js');

const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
};

const MAPPERS = {
  socrata: (rows, src) => mapRows(rows, src, { log: () => {} }),
  arcgis: (rows, src) => mapFeatures(rows, src, { log: () => {} }),
};
const ACCESS = ['yes', 'no', 'unknown'];
const REDISTRIBUTION = ['yes', 'no', 'unknown', 'attribution'];
const SYNC_MODES = ['updated_at', 'snapshot', 'date_window'];
const ROOT = path.join(__dirname, '..');
// Share of fixture rows that must map to a usable permit. Below this the
// fieldMap is probably pointing at the wrong columns.
const MIN_MAPPED = 0.9;

check('every pilot source has a registry block', () => {
  for (const slug of PILOT_AREAS) assert.ok(SOURCES[slug] && SOURCES[slug].registry, `${slug} has no registry block`);
});

for (const [slug, src] of Object.entries(SOURCES).filter(([, s]) => s.registry)) {
  const reg = src.registry;

  check(`${slug}: required config`, () => {
    for (const k of ['label', 'type', 'fieldMap', 'maxPerRun', 'maxDataAgeDays', 'dateField', 'defaultState', 'parties']) {
      assert.ok(src[k] != null, `missing ${k}`);
    }
    assert.ok(MAPPERS[src.type], `type ${src.type} has no offline mapper; connectors must use socrata or arcgis, or add one here`);
    assert.ok(src.fieldMap.permitNumber && src.fieldMap.filedDate, 'fieldMap must map permitNumber and filedDate');
    assert.ok(SYNC_MODES.includes(reg.syncMode), `syncMode ${reg.syncMode}`);
    assert.ok(reg.jurisdiction && reg.expectedInterval, 'registry needs jurisdiction and expectedInterval');
    assert.ok(src.backfillMaxPerRun == null || src.backfillMaxPerRun >= src.maxPerRun, 'backfillMaxPerRun below maxPerRun');
  });

  check(`${slug}: terms of use are recorded explicitly`, () => {
    const t = reg.terms;
    assert.ok(t, 'registry.terms missing: record what was read, or that nothing was');
    assert.ok(ACCESS.includes(t.automatedAccess), `automatedAccess ${t.automatedAccess}`);
    assert.ok(REDISTRIBUTION.includes(t.redistribution), `redistribution ${t.redistribution}`);
    // A source that says no automation stays off (hard rule 4).
    assert.ok(!(t.automatedAccess === 'no' && PILOT_AREAS.includes(slug)), 'terms forbid automation but the source is enabled');
    // A claimed permission needs a date and a page it was read on.
    if (t.automatedAccess === 'yes' || t.redistribution === 'yes' || t.redistribution === 'attribution') {
      assert.ok(t.reviewedOn && t.url, 'a permission claimed without reviewedOn and url');
    }
    if (!t.reviewedOn) console.log(`       note: ${slug} terms not yet reviewed`);
  });

  check(`${slug}: recorded fixture maps to permits`, () => {
    assert.ok(reg.fixture, 'registry.fixture missing; capture one with fixture.yml');
    const file = path.join(ROOT, reg.fixture);
    assert.ok(fs.existsSync(file), `${reg.fixture} not found`);
    const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(fx.source, slug, 'fixture is for another source');
    assert.ok(fx.rows.length >= 10, 'fixture needs at least 10 rows');

    // Every mapped column exists in the live data (else the fieldMap is guessed).
    const seen = new Set(fx.rows.flatMap((r) => Object.keys(r)));
    const absent = mappedFields(src.fieldMap).filter(({ field }) => !seen.has(field)).map(({ field }) => field);
    const required = [src.fieldMap.permitNumber, src.fieldMap.filedDate].flat();
    assert.deepStrictEqual(absent.filter((f) => required.includes(f)), [], 'required columns missing from the fixture');
    if (absent.length) console.log(`       note: ${slug} mapped columns not in this fixture (sparse or gone): ${absent.join(', ')}`);

    if (src.coordinates) {
      const { sourcePoint } = require('./enrichment/geocode.js');
      assert.ok(fx.rows.some((r) => sourcePoint(src, r)), 'coordinates are configured but no fixture row has a usable point');
    }

    const permits = MAPPERS[src.type](fx.rows, src);
    const usable = permits.filter((p) => p.permitNumber && /^\d{4}-\d{2}-\d{2}/.test(String(p.filedDate || '')));
    assert.ok(usable.length / fx.rows.length >= MIN_MAPPED, `only ${usable.length}/${fx.rows.length} rows map to a permit with a number and date`);
  });

  check(`${slug}: contractor extractor reads the fixture`, () => {
    const fx = JSON.parse(fs.readFileSync(path.join(ROOT, reg.fixture), 'utf8'));
    const parties = fx.rows.map(EXTRACTORS[slug]);
    assert.ok(parties.every((p) => p.permitNumber && p.groupKey), 'a row has no permit number or job key');
    assert.ok(parties.filter((p) => p.issuedOn).length / parties.length >= MIN_MAPPED, 'issue dates do not parse');
    assert.ok(parties.some((p) => p.name), 'no contractor names: is parties.name the right column?');
    for (const t of Object.keys(src.parties.tradeByType || {})) assert.ok(/^[A-Z]{1,5}$/.test(t), `trade code ${t}`);
  });
}
