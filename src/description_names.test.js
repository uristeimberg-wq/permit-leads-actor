const assert = require('node:assert');
const { maskNames, maskDescription } = require('./description_names.js');

const cases = [
  ['Remodel kitchen (John Smith)', 'Remodel kitchen ([name withheld])'],
  ['Remodel kitchen (Smith Residence)', 'Remodel kitchen ([name withheld] Residence)'],
  ['New deck (J. & M. Garcia)', 'New deck ([name withheld])'],
  ['SMITH RESIDENCE - NEW POOL', '[name withheld] RESIDENCE - NEW POOL'],
  ['Remodel of the Smith residence', 'Remodel of the [name withheld] residence'],
  ['Owner: Jane Doe. Replace panel', 'Owner: [name withheld]. Replace panel'],
  ['homeowner John Smith to install', 'homeowner [name withheld] to install'],
  ['Call Mr. Garcia at gate', 'Call Mr. [name withheld] at gate'],
  // Must not change:
  ['ePlan: Expedited Review - New Construction accessory Dumpster Enclosure (270 sf.)', null],
  ['New single family residence with attached garage', null],
  ['Remodel existing residence (kitchen and bath)', null],
  ['Owner builder permit, new deck', null],
  ['Replace 4-ton HVAC (like for like)', null],
  ['Mobile home replacement', null],
  ['123 Oak Dr remodel', null],
  ['Interior remodel of an existing single-family residence', null],
  ['New 2-story single-family residence with attached 2-car garage (pool is existing & to remain).', null],
  ['Upgrade service on 7504 Barcelona Dr Austin TX.', null],
  ['tunneling from the homeowner\'s side yard to the bath', null],
  ['EMERGENCY REPAIR - homeowner roof damaged by falling branch', null],
  ['Winedale 880-Q-L Is a New single-family residence with (5) bedrooms', null],
  ['All other bathroom fixtures (toilet vanity) will remain', null],
  ['Austin Energy disconnect needed (Austin Energy)', null],
  ['Remodel for homeowner John Smith, new deck', 'Remodel for homeowner [name withheld], new deck'],
  ['NEW DECK (JOHN SMITH)', 'NEW DECK ([name withheld])'],
];
for (const [input, want] of cases) {
  assert.strictEqual(maskDescription(input), want ?? input, input);
}
assert.deepStrictEqual(maskNames(null), { text: null, masked: 0 });
assert.strictEqual(maskNames('Kitchen (John Smith) and Owner: Jane Doe').masked, 2);
console.log(`description_names: ${cases.length} cases ok`);
