const assert = require('node:assert');
const { parsePage, validateRows, validationSeverity, rowColumns } = require('./validate.js');
const { classifyError } = require('../../ingest/raw.js');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { failed += 1; console.error(`FAIL - ${name}`); console.error(err); }
}

const source = {
  label: 'Test', fieldMap: { permitNumber: 'permit_no', filedDate: 'issued', submittedDate: ['applied', 'opened'] },
  dateField: 'issued', updatedAtField: 'edited',
};

check('a Socrata page must be an array of objects', () => {
  assert.deepStrictEqual(parsePage('socrata', [{ a: 1 }], 'X'), [{ a: 1 }]);
  assert.throws(() => parsePage('socrata', { message: 'query timeout' }, 'X'), /^Error: schema: X returned an unexpected socrata page/);
  assert.throws(() => parsePage('socrata', [1, 2], 'X'), /schema:/);
});

check('an ArcGIS page is features with attributes, or an error body', () => {
  assert.ok(parsePage('arcgis', { features: [{ attributes: { A: 1 } }], exceededTransferLimit: true }, 'X').features);
  assert.ok(parsePage('arcgis', { error: { code: 400, message: 'Invalid query' } }, 'X').error);
  assert.throws(() => parsePage('arcgis', { features: [{ geometry: {} }] }, 'X'), /schema:.*attributes/);
  assert.throws(() => parsePage('arcgis', '<html>maintenance</html>', 'X'), /schema:/);
});

check('a schema error is classified as schema, so the run says why it failed', () => {
  assert.strictEqual(classifyError(new Error('schema: X returned an unexpected arcgis page')), 'schema');
});

check('the checked columns are the key, mapped dates, window fields and the update column', () => {
  const c = rowColumns(source, [{ field: 'statusdate' }, { field: ':updated_at' }]);
  assert.strictEqual(c.key, 'permit_no');
  assert.deepStrictEqual(c.dates.sort(), ['applied', 'edited', 'issued', 'opened', 'statusdate']);
});

check('good rows pass: ISO and US text dates, epoch ms, missing and empty cells', () => {
  const r = validateRows([
    { permit_no: 'B-1', issued: '2026-11-01T00:00:00.000', applied: '11/01/2026' },
    { permit_no: 42, issued: 1762000000000, edited: null },
    { permit_no: 'B-3', issued: '' },
  ], source);
  assert.deepStrictEqual(r, { rows: 3, invalid: 0, byColumn: {}, samples: [] });
});

check('a missing key, an out-of-range epoch and a text that is no date are counted per column, with samples', () => {
  const r = validateRows([
    { permit_no: '', issued: '2026-11-01' },
    { permit_no: 'B-2', issued: 9e18 },
    { permit_no: 'B-3', applied: 'pending' },
    { permit_no: 'B-4', issued: '2026-11-02' },
  ], source);
  assert.strictEqual(r.invalid, 3);
  assert.deepStrictEqual(r.byColumn, { permit_no: 1, issued: 1, applied: 1 });
  assert.deepStrictEqual(r.samples.map((s) => s.column), ['permit_no', 'issued', 'applied']);
  assert.strictEqual(r.samples[2].key, 'B-3');
});

check('most rows bad is an error (a likely schema change); a few is a warning', () => {
  assert.strictEqual(validationSeverity({ rows: 10, invalid: 6 }), 'error');
  assert.strictEqual(validationSeverity({ rows: 10, invalid: 1 }), 'warning');
  assert.strictEqual(validationSeverity({ rows: 0, invalid: 0 }), 'warning');
});

console.log(failed ? `\n${failed} failed` : '\nDone.');
process.exitCode = failed ? 1 : 0;
