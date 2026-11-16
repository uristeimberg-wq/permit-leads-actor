// Socrata Open Data adapter — for cities that publish permits as a queryable
// dataset (Austin's `data.austintexas.gov` being the flagship).
//
// This is by far the cheapest source type we have: one HTTP request returns up
// to 1,000 fully-populated records, versus Accela's one browser navigation per
// permit. It also carries fields the scraped portals simply don't publish —
// Austin includes `contractor_phone` directly.
//
// As with ArcGIS, the SoQL query interface is a stable public contract and safe
// to implement generically; a given dataset's field NAMES are not, and must be
// read off the live dataset and declared per source in `fieldMap`.

const { createStatusNormalizer, normalizePermit, declaredValue, propertyClassOf } = require('../normalize.js');
const { lifecycleStage, statusKey } = require('../lifecycle.js');
const { fetchWithRetry } = require('./http.js');
const { parsePage } = require('./validate.js');

// Socrata's own per-request ceiling for the JSON endpoint.
const PAGE_SIZE = 1000;

/** SoQL wants a floating timestamp: `'YYYY-MM-DDTHH:MM:SS'`, no zone suffix. */
function toSoqlTimestamp(date) {
  return `'${date.toISOString().slice(0, 19)}'`;
}

function buildWhere(source, daysBack) {
  const clauses = [];
  if (source.dateField && daysBack) {
    const since = new Date(Date.now() - daysBack * 86400000);
    clauses.push(`${source.dateField} >= ${toSoqlTimestamp(since)}`);
  }
  if (source.where) clauses.push(`(${source.where})`);
  return clauses.join(' AND ');
}

function buildQueryUrl(source, { daysBack, offset, pageSize }) {
  const base = `https://${source.domain}/resource/${source.datasetId}.json`;
  const params = new URLSearchParams({
    $limit: String(pageSize),
    $offset: String(offset),
  });

  const where = buildWhere(source, daysBack);
  if (where) params.set('$where', where);
  // Newest first, so a capped run returns the most recent permits rather than
  // an arbitrary slice of a multi-million-row table. :id breaks ties: many rows
  // share an issue date, and offset paging over a non-unique order can skip or
  // repeat rows between pages.
  params.set('$order', source.orderBy || (source.dateField ? `${source.dateField} DESC, :id` : ':id'));

  return `${base}?${params.toString()}`;
}

/**
 * @param {object} source entry from sources.js (needs domain, datasetId, fieldMap)
 * @param {{daysBack?: number, maxRecords?: number, includeIssued?: boolean,
 *          log: object, fetchImpl?: Function, onRaw?: Function,
 *          windows?: {field: string, days: number}[]}} options
 *   onRaw(rows, {requests, truncated}) receives the unmapped rows (for raw_records).
 *   windows: several overlapping date windows (ADR-11), e.g. issue date and
 *   status date. Rows found by more than one window are returned once.
 *   maxRecords is the total across windows.
 */
async function fetchSocrataSource(source, options) {
  const { daysBack = 30, maxRecords = 2000, includeIssued = true, log, fetchImpl = fetch, onRaw, retry } = options;
  const windows = options.windows && options.windows.length
    ? options.windows
    : [{ field: source.dateField, days: daysBack }];
  let requests = 0;
  let truncated = false;

  if (!source.fieldMap) {
    throw new Error(
      `Source "${source.label}" has no fieldMap. Read the dataset's real field names ` +
        `from https://${source.domain}/api/views/${source.datasetId}.json before enabling it — ` +
        'do not guess them.',
    );
  }

  const headers = {};
  // An app token isn't required, but without one Socrata applies a stricter
  // shared rate limit. Optional so the adapter works with no configuration.
  if (process.env.SOCRATA_APP_TOKEN) headers['X-App-Token'] = process.env.SOCRATA_APP_TOKEN;

  const rows = [];
  const seen = new Set();
  const keyField = source.fieldMap.permitNumber;
  for (const w of windows) {
    const windowSource = { ...source, dateField: w.field };
    const thisWindow = new Set();
    let fetched = 0;
    for (let offset = 0; ; offset += PAGE_SIZE) {
    if (rows.length >= maxRecords) { truncated = true; break; }
    const pageSize = Math.min(PAGE_SIZE, maxRecords - rows.length);
    const url = buildQueryUrl(windowSource, { daysBack: w.days, offset, pageSize });
    log.info(`Querying ${url.slice(0, 150)}`);

    requests += 1;
    const response = await fetchWithRetry(fetchImpl, url, { headers }, { log, ...retry });
    if (!response.ok) {
      // Socrata puts the useful part of an error in the body, not the status.
      const detail = await response.text().catch(() => '');
      throw new Error(`Failed to query ${source.datasetId}: HTTP ${response.status} ${detail.slice(0, 200)}`);
    }

    // Zod check of the envelope: an error object or an HTML page in place of
    // the row array fails the run as a schema error (src/adapters/validate.js).
    const page = parsePage('socrata', await response.json(), `Socrata ${source.datasetId}`);

    fetched += page.length;
    for (const row of page) {
      // A permit an earlier window already returned is the same row; keep it
      // once. Within one window nothing is dropped.
      const key = row[keyField];
      if (key != null && key !== '') {
        if (seen.has(key)) continue;
        thisWindow.add(key);
      }
      rows.push(row);
    }
    log.info(`  -> ${page.length} rows (${rows.length} total)`);
    if (page.length < pageSize) break; // last page of this window
    }
    for (const k of thisWindow) seen.add(k);
    if (windows.length > 1) log.info(`  window ${w.field} last ${w.days}d: ${fetched} rows`);
  }

  // Hand the unmodified rows to the caller for raw_records before mapping.
  if (onRaw) await onRaw(rows, { requests, truncated, recordUrls: rows.map((r) => recordUrl(source, r)) });
  return mapRows(rows, source, { includeIssued, log });
}

/**
 * A URL that asks the dataset again for the rows published under this row's
 * key (raw_records.source_url). Null when the row has no key.
 */
function recordUrl(source, row) {
  const keyField = source.fieldMap && source.fieldMap.permitNumber;
  const key = row && typeof keyField === 'string' ? row[keyField] : null;
  if (key == null || String(key).trim() === '') return null;
  const params = new URLSearchParams({ [keyField]: String(key) });
  return `https://${source.domain}/resource/${source.datasetId}.json?${params.toString()}`;
}

const urlOf = (v) => (v && typeof v === 'object' ? v.url ?? null : v);

/** Pure row -> permit mapping, unit tested offline. */
function mapRows(rows, source, { includeIssued = true, log }) {
  const map = source.fieldMap;
  const status = createStatusNormalizer({ statusMap: source.statusMap, label: source.label });

  // A fieldMap entry may name one column or several. Austin spreads valuation
  // across a dozen columns (total_job_valuation, *_remodel, per-trade), none of
  // which is populated on most rows, so the first meaningful one wins.
  // For valuation, "meaningful" means a value that would be shown (ADR-34):
  // Austin puts a $1 filler in total_job_valuation on rows whose
  // total_valuation_remodel holds the real total, so the filler must not win.
  const isEmpty = (v) => v == null || v === '' || Number(v) === 0;
  const pick = (row, key) => {
    const spec = map[key];
    if (!spec) return undefined;
    if (!Array.isArray(spec)) return row[spec];
    const skip = key === 'valuation' ? (v) => declaredValue(v) == null : isEmpty;
    return spec.map((f) => row[f]).find((v) => !skip(v));
  };

  const permits = rows.map((row) => {
    const rawStatus = pick(row, 'status');

    return normalizePermit({
      address: source.addressMustStartWithNumber && !/^\d+\s/.test(String(buildAddress(row, map) ?? '').trim())
        ? null : buildAddress(row, map),
      // Socrata datasets carry explicit city/zip columns, which are more
      // reliable than parsing them back out of a concatenated address string.
      city: pick(row, 'city'),
      state: pick(row, 'state') ?? source.defaultState,
      zip: pick(row, 'zip'),
      jurisdiction: pick(row, 'jurisdiction') ?? source.label,
      permitType: pick(row, 'permitType'),
      workDescription: pick(row, 'workDescription'),
      valuation: pick(row, 'valuation'),
      status: status.normalize(rawStatus),
      statusRaw: rawStatus,
      // A source may override the shared wording table where a word means
      // something else there (plan review's 'Approved' is not an issued permit).
      statusStage: (source.statusStages && source.statusStages[statusKey(rawStatus)]) || undefined,
      // Socrata URL columns come back as { url }.
      permitUrl: urlOf(pick(row, 'permitUrl')),
      permitNumber: pick(row, 'permitNumber'),
      filedDate: pick(row, 'filedDate'),
      submittedOn: pick(row, 'submittedDate'),
      stageSince: pick(row, 'statusDate'),
      lifecycleStage: lifecycleStage(source, rawStatus),
      filingKind: source.filingKind || null,
      propertyClass: propertyClassOf(source.propertyClass, row),

      owner: pick(row, 'owner'),
      contractorName: pick(row, 'contractorName'),
      contractorPhone: pick(row, 'contractorPhone'),
      contractorLicence: pick(row, 'contractorLicence'),
      contractorTrade: pick(row, 'contractorTrade'),
      contractorCity: pick(row, 'contractorCity'),
      applicantName: pick(row, 'applicantName'),
      applicantPhone: pick(row, 'applicantPhone'),
    });
  });

  status.report(log);
  return includeIssued ? permits : permits.filter((p) => p.status !== 'issued');
}

/**
 * Socrata splits the address across columns. Rebuilt into the single display
 * string the UI shows, matching how scraped sources present it.
 */
function buildAddress(row, map) {
  const at = (key) => {
    const spec = map[key];
    if (!spec) return null;
    return Array.isArray(spec) ? spec.map((f) => row[f]).find(Boolean) ?? null : row[spec] ?? null;
  };
  const street = at('street');
  if (!street) return at('address');

  const city = at('city');
  const state = at('state');
  const zip = at('zip');

  const tail = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(' ');
  return tail ? `${street}, ${tail}` : String(street);
}

module.exports = { fetchSocrataSource, mapRows, buildAddress, buildQueryUrl, buildWhere, recordUrl };
