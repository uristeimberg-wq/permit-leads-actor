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
  hvac: [
    { test: /new construction/i, points: 90, label: 'New construction' },
    { test: /full.*gut remodel/i, points: 85, label: 'Full gut remodel' },
    { test: /basement.*conversion/i, points: 75, label: 'Basement conversion' },
    { test: /addition/i, minValuation: 50000, points: 70, label: 'Addition ($50K+)' },
    { test: /kitchen remodel.*range hood/i, points: 65, label: 'Kitchen remodel w/ range hood' },
  ],
  plumbing: [
    { test: /new construction/i, points: 90, label: 'New construction' },
    { test: /bathroom addition/i, points: 85, label: 'Bathroom addition' },
    { test: /(adu|basement).*conversion/i, points: 85, label: 'ADU/basement conversion' },
    { test: /kitchen remodel/i, points: 80, label: 'Kitchen remodel' },
    { test: /water heater/i, points: 50, label: 'Water heater replacement' },
  ],
  electrical: [
    { test: /new construction/i, points: 90, label: 'New construction' },
    { test: /panel upgrade.*remodel/i, points: 85, label: 'Panel upgrade + remodel' },
    { test: /(adu|basement).*conversion/i, points: 80, label: 'ADU/basement conversion' },
    { test: /ev charger.*addition/i, points: 70, label: 'EV charger + addition' },
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

  if (FILTER_OUT_PATTERNS.some((re) => re.test(desc))) {
    return { score: 0, reasons: ['Filtered: out-of-scope work type'] };
  }

  const rules = TRADE_RULES[trade.toLowerCase()];
  if (!rules) {
    throw new Error(`No scoring rules defined for trade "${trade}". Known trades: ${Object.keys(TRADE_RULES).join(', ')}`);
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

module.exports = { scorePermit, tierFor, TRADE_RULES, FILTER_OUT_PATTERNS, TIMING_BONUS };
