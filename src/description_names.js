// Masks people's names inside free-text permit descriptions before display
// (CLAUDE.md rule 5, ADR-10). Austin descriptions sometimes carry the
// homeowner's name: "Remodel kitchen (John Smith)", "Smith Residence - new
// deck", "Owner: Jane Doe". The stored description is never changed; only the
// copy a client sees is masked, and the mask says so ("[name withheld]").
//
// The rules only fire on a few shapes where a name is likely: a parenthesised
// group of 2-4 plain words, the words before "residence", and the words after
// an owner label or an honorific. A word counts as a possible name when it is
// alphabetic and not in WORDS, a list of construction and everyday vocabulary.
// It errs toward masking: losing a word of a description costs little, showing
// a homeowner's name breaks rule 5. recon/description_names.js measures it.

const MASK = '[name withheld]';

// Words that are never treated as a name. Lowercase.
const WORDS = new Set(`
a an and or of the to for in on at by with from into as is are be new old existing
proposed per plus via no not only all any each other same this that its their
residence residential res home house houses property properties lot lots unit units
bldg building buildings phase sec section block tract parcel suite apt apartment
condo condominium townhome townhouse duplex triplex fourplex multifamily family single
sfr sfd adu garage carport porch patio deck pergola fence pool spa shed barn studio
casita cottage office retail restaurant warehouse church school clinic store shop
kitchen bath bathroom bathrooms bedroom bedrooms closet laundry living dining room rooms
attic basement roof roofing foundation slab framing frame siding window windows door
doors stair stairs wall walls ceiling floor floors flooring interior exterior front back
rear side left right north south east west upper lower main first second third level
remodel remodeling renovation renovate repair repairs replace replacement install
installation addition additions alteration alterations demo demolition demolish build
construct construction finish finishout out up down convert conversion change
electrical electric plumbing mechanical hvac gas water sewer drain solar panel panels
meter service upgrade circuit circuits wiring outlet outlets lighting light lights
heater heaters furnace condenser unit ac air conditioning duct ducts ductwork
irrigation sprinkler fire alarm generator battery ev charger
sf sq ft square feet foot amp amps ton tons volt kw kwh
builder builders occupied occupant contractor provided supplied responsible
mobile manufactured modular custom spec model tiny accessory detached attached
primary principal guest pool main story stories storey one two three four five six
duplex triplex quad multi family-sized base prefab install installed installing
toilet toilets vanity vanities sink sinks shower showers tub tubs fixture fixtures
cabinet cabinets counter counters countertop countertops tile tiles appliance appliances
shingle shingles stucco brick stone siding gutter gutters skylight skylights insulation
drywall sheetrock paint painting trim carpet hardwood concrete driveway sidewalk
walkway retaining steel metal vinyl composite cedar pine wood weathered charcoal slate
austin tx texas travis county city energy utility utilities ae cps
emergency damage storm hail tree branch flood leak water-damage
north south east west mid center central
inc llc corp co company homes builders construction services group
scope work project plan plans review express expedited eplan permit permits
general misc miscellaneous interior exterior shell core tenant improvement
like kind only per code compliance repair existing site wide
green blue red white black gray grey
park creek hill hills lake ridge oak oaks view valley spring springs trail road
street st ave avenue blvd drive dr lane ln court ct circle cir way place pl cove cv
`.split(/\s+/).filter(Boolean));

const NAME_WORD = /^[A-Za-z][A-Za-z'’-]*$/;
function isNameWord(w) {
  if (!NAME_WORD.test(w) || w.length < 2 || WORDS.has(w.toLowerCase())) return false;
  const parts = w.split(/[-'’]/).filter(Boolean);
  return parts.every((p) => p.length >= 1 && !WORDS.has(p.toLowerCase()));
}

// In mixed-case text a name is capitalised, which rules out most ordinary
// words. All-caps text gives no such signal, so only the vocabulary applies.
const capitalised = (w) => /^[A-Z]/.test(w);

/** True when 2-4 words are all possible names (a leading "the" is allowed). */
function looksLikeNames(words) {
  const ws = words.filter((w) => !/^(&|and)$/i.test(w));
  return ws.length >= 1 && ws.length <= 4 && ws.every(isNameWord);
}

/**
 * The description with likely personal names replaced by "[name withheld]".
 * Returns { text, masked } where masked counts replacements.
 */
function maskNames(input) {
  if (input == null || input === '') return { text: input, masked: 0 };
  let text = String(input);
  let masked = 0;
  const letters = text.replace(/[^A-Za-z]/g, '');
  const mixed = letters.length > 0 && (letters.replace(/[^a-z]/g, '').length / letters.length) > 0.3;
  const nameOk = (w) => isNameWord(w) && (!mixed || capitalised(w));
  const joiner = (w) => /^(&|and)$/i.test(w);

  // 1. "(John Smith)", "(Smith Residence)", "(J. & M. Garcia)".
  text = text.replace(/\(([^()]{2,60})\)/g, (all, inner) => {
    const words = inner.replace(/\./g, ' ').trim().split(/\s+/);
    const tail = words.length > 1 && /^(residence|res|home|house|property|family)$/i.test(words[words.length - 1]) ? words.pop() : null;
    const ws = words.filter((w) => !joiner(w));
    const allOk = ws.every((w) => nameOk(w) || /^[A-Z]$/i.test(w));
    if (ws.length >= (tail ? 1 : 2) && ws.length <= 4 && allOk && ws.some(nameOk)) {
      masked += 1;
      return `(${MASK}${tail ? ` ${tail}` : ''})`;
    }
    return all;
  });

  // 2. "Smith Residence", "John and Mary Smith residence".
  text = text.replace(/(?<![A-Za-z0-9'’-])((?:[A-Za-z][A-Za-z'’-]+\s+(?:(?:&|and)\s+)?){1,4})(residence|res\.)(?![A-Za-z])/gi, (all, names, word) => {
    const ws = names.trim().split(/\s+/);
    // Keep leading vocabulary: "remodel of smith residence" -> "remodel of [..] residence".
    let i = 0;
    while (i < ws.length && !nameOk(ws[i])) i += 1;
    const tail = ws.slice(i);
    if (!tail.length || tail.length > 4 || !tail.every((w) => nameOk(w) || joiner(w)) || joiner(tail[tail.length - 1])) return all;
    masked += 1;
    return `${ws.slice(0, i).map((w) => `${w} `).join('')}${MASK} ${word}`;
  });

  // 3. "Owner: Jane Doe", "Homeowner - John Smith", "Mr. Smith". Without an
  // explicit ":" or "-", an owner label only counts in mixed-case text where
  // the next words are capitalised.
  text = text.replace(/(?<![A-Za-z])((?:home\s*|property\s+)?owners?|mrs?|ms)(\.?\s*(?:[:\-–]\s*)?)((?:[A-Za-z][A-Za-z'’-]+\s*(?:(?:&|and)\s+)?){1,3})/gi,
    (all, label, sep, names) => {
      const honorific = /^(mrs?|ms)$/i.test(label);
      const explicit = /[:\-–]/.test(sep);
      if (!sep.length) return all;
      if (!honorific && !explicit && !mixed) return all;
      const okHere = (w) => nameOk(w) && (explicit || capitalised(w));
      const ws = names.trim().split(/\s+/);
      let n = 0;
      while (n < ws.length && (okHere(ws[n]) || (n > 0 && joiner(ws[n])))) n += 1;
      while (n > 0 && joiner(ws[n - 1])) n -= 1;
      if (n === 0) return all;
      masked += 1;
      const rest = ws.slice(n).join(' ');
      const trailing = /\s$/.test(names) ? ' ' : '';
      return `${label}${sep}${MASK}${rest ? ` ${rest}` : ''}${trailing}`;
    });

  return { text, masked };
}

/** The masked description only. */
const maskDescription = (s) => maskNames(s).text;

module.exports = { maskNames, maskDescription, MASK, WORDS };
