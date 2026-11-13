const assert = require('node:assert');
const { canonicalJson, payloadHash, toRawRecords, classifyError } = require('./raw.js');
const { SOURCES } = require('../src/sources.js');

function check(name, fn) {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const austin = SOURCES['austin-tx'];
const miami = SOURCES['miami-dade-fl'];

check('canonical JSON ignores key order at every level', () => {
  assert.strictEqual(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } }), '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}');
  assert.strictEqual(payloadHash({ x: 1, y: 2 }), payloadHash({ y: 2, x: 1 }));
});

check('any value change changes the hash', () => {
  assert.notStrictEqual(payloadHash({ status: 'Active' }), payloadHash({ status: 'Final' }));
  assert.notStrictEqual(payloadHash({ v: null }), payloadHash({ v: '' }));
});

check('raw records are keyed by the source permit-number column', () => {
  const { records, failed } = toRawRecords([{ permit_number: ' 2026-1 BP ', x: 1 }], austin);
  assert.strictEqual(failed, 0);
  assert.strictEqual(records[0].sourceKey, '2026-1 BP');
  assert.strictEqual(records[0].payload.x, 1);
  assert.match(records[0].payloadHash, /^[0-9a-f]{64}$/);
});

check('Miami-Dade raw records use PermitNumber', () => {
  const { records } = toRawRecords([{ PermitNumber: '2025014493', City: 'MIAMI' }], miami);
  assert.strictEqual(records[0].sourceKey, '2025014493');
});

check('a row without a key is counted as failed, never stored under a made-up key', () => {
  const { records, failed } = toRawRecords([{ permit_number: '' }, { permit_number: null }, {}, { permit_number: 'A' }], austin);
  assert.strictEqual(failed, 3);
  assert.deepStrictEqual(records.map((r) => r.sourceKey), ['A']);
});

check('the same row twice in one fetch is stored once; a changed row is a second version', () => {
  const rows = [{ permit_number: 'A', s: 1 }, { s: 1, permit_number: 'A' }, { permit_number: 'A', s: 2 }];
  const { records } = toRawRecords(rows, austin);
  assert.strictEqual(records.length, 2);
});

check('Socrata :updated_at is carried as source_updated_at when present', () => {
  const { records } = toRawRecords([{ permit_number: 'A', ':updated_at': '2026-11-12T15:26:31.000Z' }], austin);
  assert.strictEqual(records[0].sourceUpdatedAt, '2026-11-12T15:26:31.000Z');
});

check('a source without a permitNumber field refuses to build raw records', () => {
  assert.throws(() => toRawRecords([{}], { label: 'X', fieldMap: {} }), /stable key/);
});

check('errors map to a class, and unrecognised ones to unknown', () => {
  assert.strictEqual(classifyError(new Error('Failed to query x: HTTP 429 slow down')), 'rate_limited');
  assert.strictEqual(classifyError(new Error('Failed to query x: HTTP 503')), 'transient');
  assert.strictEqual(classifyError(new Error('Failed to query x: HTTP 403')), 'auth');
  assert.strictEqual(classifyError(new Error('fetch failed')), 'transient');
  assert.strictEqual(classifyError(new Error('Source "X" has no fieldMap. Read ...')), 'schema');
  assert.strictEqual(classifyError(new Error('ArcGIS error 400: Invalid field: Foo')), 'schema');
  assert.strictEqual(classifyError(new SyntaxError('Unexpected token < in JSON')), 'bad_data');
  assert.strictEqual(classifyError(new TypeError('x is not a function')), 'bug');
  assert.strictEqual(classifyError(new Error('something odd')), 'unknown');
});
