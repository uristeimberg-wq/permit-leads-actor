// Which photo sources the job page may use (docs/IMAGERY.md, ADR-24).
// Read from the environment on each request, so setting the Railway variable
// and redeploying is all it takes.

// Google browser keys start "AIza" and are 39 characters. Anything else is
// treated as unset, so a pasted typo hides the photo instead of breaking it.
const GOOGLE_KEY = /^AIza[0-9A-Za-z_-]{35}$/;

/**
 * { googleKey } for the browser. GOOGLE_MAPS_BROWSER_KEY is the Street View
 * Static key; absent or malformed means no photo card.
 */
function imageryConfig(env = process.env) {
  const key = String(env.GOOGLE_MAPS_BROWSER_KEY || '').trim();
  return {
    googleKey: GOOGLE_KEY.test(key) ? key : null,
  };
}

module.exports = { imageryConfig };
