// Offline tests for web/public/links.js.
const assert = require('assert');
const { safeHttpUrl, telHref } = require('./links.js');

let n = 0;
const t = (name, fn) => { fn(); n++; };

t('accepts https and http', () => {
  assert.strictEqual(safeHttpUrl('https://abc2.austintexas.gov/x?y=1'), 'https://abc2.austintexas.gov/x?y=1');
  assert.strictEqual(safeHttpUrl('  HTTP://example.gov/a '), 'http://example.gov/a');
});
t('refuses script and data URLs', () => {
  assert.strictEqual(safeHttpUrl('javascript:alert(1)'), null);
  assert.strictEqual(safeHttpUrl(' JavaScript:alert(1)'), null);
  assert.strictEqual(safeHttpUrl('data:text/html,<b>x</b>'), null);
});
t('refuses relative, protocol-relative and non-strings', () => {
  assert.strictEqual(safeHttpUrl('/permit/1'), null);
  assert.strictEqual(safeHttpUrl('//evil.example/x'), null);
  assert.strictEqual(safeHttpUrl(null), null);
  assert.strictEqual(safeHttpUrl(undefined), null);
  assert.strictEqual(safeHttpUrl(42), null);
});
t('telHref normalizes US numbers', () => {
  assert.strictEqual(telHref('5128737333'), 'tel:+15128737333');
  assert.strictEqual(telHref('(305)333-5153'), 'tel:+13053335153');
  assert.strictEqual(telHref('1-512-555-0142'), 'tel:+15125550142');
});
t('telHref refuses junk and missing values', () => {
  assert.strictEqual(telHref('javascript:alert(1)'), null);
  assert.strictEqual(telHref('555-0142'), null);
  assert.strictEqual(telHref(''), null);
  assert.strictEqual(telHref(undefined), null);
});

console.log(`links.test.js: ${n} passed`);
