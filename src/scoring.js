// Trade relevance scoring — deterministic version of the scoring logic
// already used in the /permits skill. Same tiers, same point values.
// Score a permit's work description (+ valuation, status) for how likely
// it is to generate work for a given trade.

const FILTER_OUT_PATTERNS = [
  /solar/i,
  /foundation pier/i,
  /seismic bolt/i,
  /\bdeck\b/i,
  /\bfence\b/i,
  /demolition/i,
  /roof[\s-]?only/i,
  /panel revision/i,
  /siding[\s-]?only/i,
];

// Each rule: { test: RegExp on work description, points, label, optional
// minValuation/maxValuation, optional requiresKeyword }
// Rules are checked in order; the highest-scoring match wins per permit.
const TRADE_RULES = {
  flooring: [
    { test: /new\s+(sfr|single[\s-]family|townhouse|adu)/i, points: 90, label: 'New construction' },
    { test: /(whole[\s-]house|full interior)\s+remodel/i, points: 90, label: 'Whole-house remodel' },
    { test: /basement.*(living space|conversion)/i, points: 85, label: 'Basement → living space conversion' },
    { test: /garage.*adu/i, points: 85, label: 'Garage → ADU conversion' },
    { test: /(fire|water)\s+damage/i, points: 85, label: 'Fire/water damage repair' },
    { test: /addition/i, minValuation: 75000, points: 80, label: 'Large addition ($75K+)' },
    { test: /kitchen remodel/i, requiresKeyword: /wall removal/i, points: 70, label: 'Structural kitchen remodel' },
    { test: /interior remodel/i, minValuation: 50000, points: 65, label: 'High-value interior remodel ($50K+)' },
    { test: /new dwelling unit/i, points: 60, label: 'New dwelling unit created' },
    { test: /remodel/i, minValuation: 20000, maxValuation: 49999, points: 40, label: 'Mid-value remodel ($20-49K)' },
    { test: /bathroom addition/i, points: 30, label: 'Single bathroom addition' },
  ],
  painting: [
    { test: /new construction/i, points: 85, label: 'New construction' },
    { test: /whole[\s-]house remodel/i, points: 85, label: 'Whole-house remodel' },
    // Anchored: unanchored, this matched "Reside" inside "Residential" and
    // scored every residential permit as a Tier A exterior re-side.
    { test: /\bre[\s-]?sid(?:e|ing)\b/i, points: 75, label: 'Exterior re-side' },
    { test: /(large|full) interior remodel/i, points: 70, label: 'Large interior remodel' },
  ],
  roofing: [
    { test: /re[\s-]?roof/i, points: 95, label: 'Re-roof permit' },
    { test: /(fire|storm) damage/i, points: 90, label: 'Fire/storm damage' },
    { test: /new construction/i, points: 85, label: 'New construction' },
  ],
};

// ── Electrical, plumbing and HVAC (approved by the owner 2026-11-14) ──────
// Written against the permit vocabulary of the four pilot markets, not the
// prototype's Portland prose. Rules apply in order; the first match decides.
// Evidence: 95 recorded permits (test/fixtures/sources), before/after in
// docs/TRADE_SCORING.md.
const SUB_TRADES = ['electrical', 'plumbing', 'hvac'];

// 1. A permit FOR a trade (Austin EP/MP/PP, Raleigh "DSINSP - Electrical",
//    City of Miami MECHANICAL/PLUMBING) means that sub is already on the job:
//    not a lead for any trade. Matched on the permit type, never the text.
const TRADE_PERMIT_TYPE = /electric|mechanical|plumb|\bgas\b|\bhvac\b|^(EP|MP|PP)\b/i;
// 2. Permit types that are not building work. Raleigh copies the parent
//    building permit's description onto these.
const NOT_BUILDING_TYPE = /right of way|driveway|sidewalk|\bsigns?\b|fence|demolition|special event|fire|sprinkler|pool/i;
// 3. New homes and units need every trade. City of Miami's "NEW CONSTRUCTION"
//    type is used for every component of a new building, so the TYPE alone
//    never counts; the description must say it.
const NEW_HOME = /\bnew\s+(sfr|sfd|single[\s-]family|house|home|residence|duplex|condo|dwelling|apartment|multi[\s-]?family)|new construction of .*(residen|home|sfr|condo|unit|dwelling)|\btownhom(e|es)\b|\b\d+\s+units?\b|single family (residence|house)|dwelling unit/i;
// 4. Site and envelope work only.
const SITE_ONLY = /\b(fence|gate|signs?|driveways?|sidewalk|approach|parking lot|paving|trusses|railings?|louvres?|windows?|doors?|re-?roof|roof|foundation|crawl ?space|framing repairs?|piers?|demo(lition)?|temporary toilets?|special events?|retaining wall|shed|dumpster enclosure|sewer capping|pools?|spa|fountain|deck|porch)\b/i;
const ROOMS = /\b(bed ?rooms?|bath(room)?s?|half bath|kitchen|family room|living|suite|closet|office|dwelling)\b/i;
// 5. Additions, conversions, build-outs; then remodels; then any mention.
const ADDITION = /\baddition\b|\badu\b|accessory dwelling|garage conversion|basement.*conversion|build[\s-]?out|finish[\s-]?out|(gut|full|whole[\s-]house|interior)\s+(remodel|renovat)/i;
// A build-out mentioning a pool deck is still a build-out.
const INTERIOR_WORK = /build[\s-]?out|finish[\s-]?out|remodel|renovat/i;
const REMODEL = /\bremodel|renovat|alteration|convert/i;
const TRADE_WORDS = {
  electrical: /\b(electric(al)?|panel|circuits?|wiring|rewire|receptacles?|outlets?|lights?|lighting|ev charger|meter|sub-?panel|service upgrade)\b/i,
  plumbing: /\b(bath(room)?s?|kitchen|shower|tub|toilet|lavatory|sink|water heater|plumbing|re-?pip(e|ing)|fixtures?|gas line)\b/i,
  hvac: /\b(hvac|a\/?c|air condition(er|ing)?|heat pump|furnace|duct(work)?|mini[\s-]?split|ventilation|venting|exhaust)\b/i,
};

/** The rule-based score for electrical, plumbing or HVAC, with the rule that set it. */
function scoreSubTrade(permit, trade) {
  const type = permit.permitType || '';
  // toScorable() prefixes the type; the rules read the description alone.
  const desc = permit.description != null ? String(permit.description) : (permit.workDescription || '');

  if (type && TRADE_PERMIT_TYPE.test(type)) {
    return { score: 0, reasons: ['Trade permit: that sub is already on the job, not a lead'] };
  }
  if (type && NOT_BUILDING_TYPE.test(type)) return { score: 0, reasons: [`Not building work (permit type "${type}")`] };
  if (NEW_HOME.test(desc)) return { score: 90, reasons: ['New home or units'] };

  const named = TRADE_WORDS[trade].test(desc);
  if (SITE_ONLY.test(desc) && !named && !(ADDITION.test(desc) && (ROOMS.test(desc) || INTERIOR_WORK.test(desc)))) {
    return { score: 0, reasons: ['Site or envelope work only'] };
  }
  if (ADDITION.test(desc)) return named ? { score: 85, reasons: ['Addition or build-out naming this trade'] } : { score: 65, reasons: ['Addition or build-out'] };
  if (named && REMODEL.test(desc)) return { score: 75, reasons: ['Remodel naming this trade'] };
  // City of Miami lists trade line items ("ROUGH WIRING OUTLETS|..."); they
  // usually belong to the sub's own permit, so the work is likely taken.
  if (named && desc.includes('|')) return { score: 50, reasons: ['Itemized trade scope (likely the sub\'s own permit)'] };
  if (named) return { score: 50, reasons: ['Names this trade'] };
  if (REMODEL.test(desc)) return { score: 35, reasons: ['Remodel, trade not named'] };
  return { score: 0, reasons: [] };
}

// Applied permits score higher than issued — bids aren't locked in yet.
const TIMING_BONUS = {
  applied: 12,
  issued: 5,
};

/**
 * @param {{workDescription: string, valuation?: number, status?: string}} permit
 * @param {string} trade
 * @returns {{score: number, reasons: string[]}}
 */
function scorePermit(permit, trade) {
  const desc = permit.workDescription || '';
  const key = String(trade).toLowerCase();

  if (SUB_TRADES.includes(key)) return withTiming(scoreSubTrade(permit, key), permit);

  if (FILTER_OUT_PATTERNS.some((re) => re.test(desc))) {
    return { score: 0, reasons: ['Filtered: out-of-scope work type'] };
  }

  const rules = TRADE_RULES[key];
  if (!rules) {
    throw new Error(`No scoring rules defined for trade "${trade}". Known trades: ${[...Object.keys(TRADE_RULES), ...SUB_TRADES].join(', ')}`);
  }

  let best = { score: 0, reasons: [] };
  const valuation = permit.valuation || 0;

  for (const rule of rules) {
    if (!rule.test.test(desc)) continue;
    if (rule.minValuation && valuation < rule.minValuation) continue;
    if (rule.maxValuation && valuation > rule.maxValuation) continue;
    if (rule.requiresKeyword && !rule.requiresKeyword.test(desc)) continue;
    if (rule.points > best.score) {
      best = { score: rule.points, reasons: [rule.label] };
    }
  }

  return withTiming(best, permit);
}

function withTiming(best, permit) {
  if (best.score > 0) {
    const status = (permit.status || '').toLowerCase();
    const bonus = TIMING_BONUS[status] || 0;
    if (bonus) {
      best.score += bonus;
      best.reasons.push(`Timing bonus (${status}): +${bonus}`);
    }
  }
  return best;
}

/** @param {number} score @returns {'A'|'B'|'C'|null} */
function tierFor(score) {
  if (score >= 80) return 'A';
  if (score >= 50) return 'B';
  if (score >= 25) return 'C';
  return null; // below threshold — caller should drop it
}

module.exports = { scorePermit, tierFor, TRADE_RULES, FILTER_OUT_PATTERNS, TIMING_BONUS, SUB_TRADES };
