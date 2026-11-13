// Offline test for the pure helpers in recon/enrichment_sources.js.
const assert = require('node:assert');
const { shape, digits, parseCsvLine, profile, fixed } = require('./enrichment_sources');

assert.strictEqual(shape('CGC061097'), 'AAA999999');
assert.strictEqual(shape(' 01-3114-009-0010 '), '99-9999-999-9999');
assert.strictEqual(digits('1 (512) 555-0100'), '5125550100');
assert.deepStrictEqual(parseCsvLine('"06","Electrical","A, B","",EC13001234'), ['06', 'Electrical', 'A, B', '', 'EC13001234']);
assert.deepStrictEqual(parseCsvLine('"say ""hi""",x'), ['say "hi"', 'x']);
assert.strictEqual(fixed('000000123456R    2026 ', 1, 12), '000000123456');
assert.strictEqual(fixed('000000123456R    2026 ', 18, 22), '2026');

const p = profile();
[['A1', 'x'], ['A1', ''], ['B2', 'y']].forEach((r) => p.add(r));
const [c0, c1] = p.report(3, { show: [0], shapes: [0] });
assert.strictEqual(c0.fillPct, 100);
assert.strictEqual(c0.top, 'A1:2 B2:1');
assert.strictEqual(c0.shapes, 'A9:3');
assert.strictEqual(c1.fillPct, 66.7);
assert.strictEqual(c1.top, undefined);
const { licKey, xlsxRows } = require('./enrichment_sources');
assert.strictEqual(licKey('CGC061097'), 'CGC61097');
assert.strictEqual(licKey('cgc 1517001'), 'CGC1517001');
assert.strictEqual(licKey('EC0001234'), 'EC1234');
assert.strictEqual(licKey(''), '');
assert.strictEqual(licKey('12-ABC'), '');
const sheet = '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12</v></c></row>'
  + '<row r="2"><c r="A2" t="inlineStr"><is><t>geo_id</t></is></c><c r="B2"/></row></sheetData>';
assert.deepStrictEqual(xlsxRows(sheet, '<sst><si><t>prop_id &amp; x</t></si></sst>'), [['prop_id & x', '12'], ['geo_id', '']]);
console.log('enrichment_sources tests passed');
