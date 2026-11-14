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

// Released 2026-11-14 (owner lifted the freeze; the verification audit found
// all three rest on official keys: TCAD geo id, TCAD property id, and permits
// alone disagreeing is not a property conflict). Kept as switches so any one
// can be held again in one line.
const HOLDS = {
  austinParcelPoints: false,
  tcadLotSize: false,
  permitOnlyNotConflict: false,
};

/** Parcel providers whose points Locate permits must not use while held. */
const heldPointProviders = (holds = HOLDS) => (holds.austinParcelPoints ? ['austin-parcels'] : []);

module.exports = { HOLDS, heldPointProviders };
