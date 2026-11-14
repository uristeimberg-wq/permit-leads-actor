// Data held back until the verification audit approves it (owner's freeze,
// 2026-11-14: "we built too far ahead without understanding the data").
// Each hold switches a step off; nothing is deleted. Set one to false only
// when the audit (thread "Show only verified permit data") has passed it.
//
//   austinParcelPoints: PR #73. Austin map points from City of Austin parcel
//     centroids. The fetch step is off in sync.yml, and Locate permits ignores
//     parcels of the held providers, so no permit is placed by them.
//   tcadLotSize: PR #70. Austin lot size from Travis CAD land segments. Not
//     read; the next Travis CAD run stores lot size as missing (NULL).
//   permitOnlyNotConflict: PR #75 (fields-v3). While held, permits alone
//     that disagree are an open conflict again, as under fields-v2.

const HOLDS = {
  austinParcelPoints: true,
  tcadLotSize: true,
  permitOnlyNotConflict: true,
};

/** Parcel providers whose points Locate permits must not use while held. */
const heldPointProviders = (holds = HOLDS) => (holds.austinParcelPoints ? ['austin-parcels'] : []);

module.exports = { HOLDS, heldPointProviders };
