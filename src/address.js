// Address parsing — turns a permit's single address string into the place
// fields the platform filters on (zip, city, state).
//
// Formats seen in live data:
//   "6491 SE VERNELDA ST, MILWAUKIE OR 97267"        Clackamas
//   "2123 NW FENDLE WAY, LOT 7, MCMINNVILLE OR 97128" Oregon (lot number)
//   "1103 LINCOLN ST, THE DALLES OREGON 97058"        state spelled out
//   "35435 TOHL AVE, TILLAMOOK COUNTY OR"             no ZIP at all
//
// This is deliberately conservative: anything it can't read comes back null.
// A wrong ZIP files a permit under the wrong town, which is worse for the user
// than an honest blank — but a missing ZIP shouldn't cost us the city/state we
// CAN read, since those drive the city and jurisdiction pickers.

const STATE_NAMES = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
  KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
  MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS',
  MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK',
  OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT',
  VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI',
  WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC',
};

// Only these count as a state abbreviation. Without this check, any two-letter
// token passes — and "123 MAIN ST 97201" parses with a state of "ST".
const STATE_CODES = new Set(Object.values(STATE_NAMES));

// Parsing works from the END of the string inward — strip the ZIP, then the
// state, and whatever sits after the last remaining comma is the city. Doing it
// this way instead of with one big regex avoids the backtracking trap where
// "THE DALLES OREGON" matches with "DALLES OREGON" captured as the state.

// A trailing ZIP, required to be preceded by a space or comma so a leading
// house number ("97267 SE MAIN ST") is never mistaken for one.
const TRAILING_ZIP = /[\s,](\d{5})(?:-\d{4})?\s*$/;
const CITY_SHAPE = /^[A-Za-z][A-Za-z .'\-]*$/;

/** Accepts "OR" or "Oregon"; returns null for anything that isn't a state. */
function normalizeState(token) {
  if (!token) return null;
  const upper = token.trim().toUpperCase();
  if (upper.length === 2) return STATE_CODES.has(upper) ? upper : null;
  return STATE_NAMES[upper] ?? null;
}

const EMPTY = { street: null, city: null, state: null, zip: null };

/**
 * @param {string|null|undefined} raw
 * @returns {{street: string|null, city: string|null, state: string|null, zip: string|null}}
 */
function parseAddress(raw) {
  if (typeof raw !== 'string') return { ...EMPTY };

  let text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return { ...EMPTY };

  // 1. ZIP.
  let zip = null;
  const zipMatch = text.match(TRAILING_ZIP);
  if (zipMatch) {
    zip = zipMatch[1];
    text = text.slice(0, zipMatch.index).trim();
  }

  // 2. State — try a two-word name ("NEW YORK") before a one-word one, so
  //    multi-word states aren't truncated to their last word.
  let state = null;
  const words = text.split(' ').filter(Boolean);
  if (words.length >= 2) {
    const twoWord = normalizeState(words.slice(-2).join(' '));
    if (twoWord) {
      state = twoWord;
      words.splice(-2, 2);
    }
  }
  if (!state && words.length >= 1) {
    const oneWord = normalizeState(words[words.length - 1].replace(/,$/, ''));
    if (oneWord) {
      state = oneWord;
      words.pop();
    }
  }
  text = words.join(' ').replace(/,\s*$/, '').trim();

  // 3. City — only what follows the last comma, so trailing street words are
  //    never promoted into a city name.
  let city = null;
  let street = text;
  const lastComma = text.lastIndexOf(',');
  if (lastComma >= 0) {
    const candidate = text.slice(lastComma + 1).trim();
    if (candidate && CITY_SHAPE.test(candidate)) {
      city = candidate.toUpperCase();
      street = text.slice(0, lastComma).trim();
    }
  }

  return { street: street || null, city, state, zip };
}

module.exports = { parseAddress, normalizeState, STATE_CODES };
