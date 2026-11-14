const assert = require('node:assert');
const { imageryConfig } = require('./imagery.js');

let n = 0;
const check = (name, fn) => { fn(); n += 1; };

check('no key: no photo card', () => {
  assert.deepStrictEqual(imageryConfig({}), { googleKey: null });
});
check('a well-formed key is passed to the browser', () => {
  const key = `AIza${'x'.repeat(35)}`;
  assert.strictEqual(imageryConfig({ GOOGLE_MAPS_BROWSER_KEY: ` ${key} ` }).googleKey, key);
});
check('a malformed key is treated as unset', () => {
  for (const k of ['AIza123', 'sk-live-abc', `AIza${'x'.repeat(35)}"><script>`]) {
    assert.strictEqual(imageryConfig({ GOOGLE_MAPS_BROWSER_KEY: k }).googleKey, null, k);
  }
});
console.log(`imagery: ${n} checks passed`);
