const { Actor, log } = require('apify');
const { scorePermit, tierFor } = require('./scoring.js');
const { toScorable } = require('./normalize.js');
const { SOURCES } = require('./sources.js');
const { getAdapter } = require('./adapters/index.js');
const { redactPermit } = require('./privacy.js');

Actor.main(async () => {
  const input = (await Actor.getInput()) ?? {};
  const {
    area = 'portland-or',
    trade = 'flooring',
    includeIssued = true,
    minScore = 25,
    daysBack = 30,
    maxRecords = 1000,
  } = input;

  const source = SOURCES[area];
  if (!source) {
    throw new Error(`No data source configured for area "${area}". Supported: ${Object.keys(SOURCES).join(', ')}`);
  }

  const fetchSource = getAdapter(source.type);
  const permits = await fetchSource(source, {
    includeIssued,
    daysBack,
    maxRecords,
    log,
  });

  const leads = [];
  for (const permit of permits) {
    // toScorable re-joins permitType with the description; scoring wants both.
    const { score, reasons } = scorePermit(toScorable(permit), trade);
    if (score < minScore) continue;

    // The dataset is an export: owner and applicant fields stay out (rule 5).
    leads.push({ ...redactPermit(permit), area, trade, score, tier: tierFor(score), reasons });
  }

  leads.sort((a, b) => b.score - a.score);
  await Actor.pushData(leads);

  log.info(`Done. ${leads.length} leads scored >= ${minScore} for "${trade}" in "${area}".`);
});
