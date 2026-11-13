// CSV export adapter — a source that serves permit rows as a plain CSV file at
// a URL. Extracted verbatim from the original main.js fetch loop.

const { parse } = require('csv-parse/sync');
const { createStatusNormalizer, normalizePermit } = require('../normalize.js');

/**
 * @param {object} source  entry from sources.js (needs appliedUrl + columnMap)
 * @param {{includeIssued: boolean, log: object}} options
 * @returns {Promise<object[]>} normalized permits
 */
async function fetchCsvSource(source, { includeIssued, log }) {
  const urlsToFetch = [source.appliedUrl];
  if (includeIssued && source.issuedUrl) urlsToFetch.push(source.issuedUrl);

  const rawRows = [];
  for (const url of urlsToFetch) {
    log.info(`Fetching ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    }
    const csvText = await response.text();
    const rows = parse(csvText, { columns: true, skip_empty_lines: true, relax_column_count: true });
    rawRows.push(...rows);
    log.info(`  -> ${rows.length} rows`);
  }

  return mapRows(rawRows, source, log);
}

/**
 * Row-to-permit mapping, split out so it can be unit tested against a saved
 * fixture without touching the network.
 */
function mapRows(rawRows, source, log) {
  const map = source.columnMap;
  const status = createStatusNormalizer({ statusMap: source.statusMap, label: source.label });

  const permits = rawRows.map((row) =>
    normalizePermit({
      address: row[map.address],
      jurisdiction: map.jurisdiction ? row[map.jurisdiction] : source.label,
      permitType: map.permitType ? row[map.permitType] : null,
      workDescription: row[map.workDescription],
      valuation: row[map.valuation],
      status: status.normalize(row[map.status]),
      statusRaw: row[map.status],
      permitUrl: row[map.permitUrl],
      permitNumber: map.permitNumber ? row[map.permitNumber] : null,
      filedDate: map.filedDate ? row[map.filedDate] : null,
    }),
  );

  status.report(log);
  return permits;
}

module.exports = { fetchCsvSource, mapRows };
