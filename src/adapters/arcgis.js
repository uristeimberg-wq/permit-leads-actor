// ArcGIS Feature Service adapter — for jurisdictions that publish permits as a
// queryable REST layer. This is the cleanest kind of source: structured JSON,
// no browser, server-side filtering and paging.
//
// The /query interface used here is the standard ArcGIS REST contract, so it is
// safe to implement generically. What is NOT generic is a given layer's field
// NAMES — those must be read off the live layer and declared per source in
// `fieldMap`. Do not guess them.

const { createStatusNormalizer, normalizePermit } = require('../normalize.js');
const { lifecycleStage } = require('../lifecycle.js');
const { fetchWithRetry } = require('./http.js');

const PAGE_SIZE = 500;

/** ArcGIS expects `timestamp 'YYYY-MM-DD HH:MM:SS'` in where clauses. */
function toArcgisTimestamp(date) {
  return `timestamp '${date.toISOString().slice(0, 19).replace('T', ' ')}'`;
}

function buildWhere(source, daysBack) {
  const clauses = [];
  if (source.dateField && daysBack) {
    const since = new Date(Date.now() - daysBack * 86400000);
    clauses.push(`${source.dateField} >= ${toArcgisTimestamp(since)}`);
  }
  if (source.where) clauses.push(`(${source.where})`);
  return clauses.length ? clauses.join(' AND ') : '1=1';
}

function buildQueryUrl(source, { daysBack, offset, pageSize }) {
  const layer = source.layerUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({
    f: 'json',
    where: buildWhere(source, daysBack),
    // A source may list the columns it reads (inspections: no inspector or
    // contact names are ever requested); otherwise every column.
    outFields: Array.isArray(source.outFields) && source.outFields.length ? source.outFields.join(',') : '*',
    returnGeometry: 'false',
    resultOffset: String(offset),
    resultRecordCount: String(pageSize),
  });
  if (source.orderByFields) params.set('orderByFields', source.orderByFields);
  return `${layer}/query?${params.toString()}`;
}

/**
 * @param {object} source entry from sources.js (needs layerUrl + fieldMap)
 * @param {{daysBack?: number, maxRecords?: number, includeIssued?: boolean,
 *          log: object, fetchImpl?: Function, onRaw?: Function}} options
 *   onRaw(rows, {requests}) receives the unmapped attributes (for raw_records).
 */
async function fetchArcgisSource(source, options) {
  // A market split across layers (Raleigh: building permits and "permits other
  // than buildings") reads each layer with the same fieldMap, then hands the
  // rows over as one run. Permit numbers must not collide across the layers.
  // A window may name one layer (`layer`: its index), for a date field only
  // that layer has (Raleigh: applieddate vs CreationDate).
  if (Array.isArray(source.layerUrls)) {
    let raw = [];
    let requests = 0;
    let truncated = false;
    const permits = [];
    for (const [i, layerUrl] of source.layerUrls.entries()) {
      const windows = options.windows && options.windows.filter((w) => w.layer == null || w.layer === i);
      permits.push(...await fetchArcgisSource({ ...source, layerUrls: undefined, layerUrl }, {
        ...options, windows, onRaw: async (rows, meta) => { raw = raw.concat(rows); requests += meta.requests; truncated = truncated || meta.truncated; },
      }));
    }
    if (options.onRaw) await options.onRaw(raw, { requests, truncated });
    return permits;
  }
  const { daysBack = 30, maxRecords = 2000, includeIssued = true, log, fetchImpl = fetch, onRaw, retry } = options;
  // Several date windows (ADR-11), each newest first by its own field; a row
  // more than one window finds is kept once. maxRecords is the total.
  const windows = options.windows && options.windows.length ? options.windows : [{ field: source.dateField, days: daysBack }];
  let requests = 0;
  let truncated = false;

  if (!source.fieldMap) {
    throw new Error(
      `Source "${source.label}" has no fieldMap. Read the layer's real field names ` +
        `from ${source.layerUrl}?f=json before enabling it — do not guess them.`,
    );
  }

  const features = [];
  const seen = new Set();
  const keyField = source.fieldMap.permitNumber;
  for (const w of windows) {
  const windowSource = w.field === source.dateField ? source : {
    ...source, dateField: w.field,
    orderByFields: source.orderByFields && source.orderByFields.replace(source.dateField, w.field),
  };
  const thisWindow = new Set();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    if (features.length >= maxRecords) { truncated = true; break; }
    const pageSize = Math.min(PAGE_SIZE, maxRecords - features.length);
    const url = buildQueryUrl(windowSource, { daysBack: w.days, offset, pageSize });
    log.info(`Querying ${url.slice(0, 140)}`);

    requests += 1;
    const response = await fetchWithRetry(fetchImpl, url, undefined, { log, ...retry });
    if (!response.ok) throw new Error(`Failed to query ${source.layerUrl}: HTTP ${response.status}`);
    const body = await response.json();

    // ArcGIS reports failures in a 200 body rather than an HTTP status.
    if (body.error) {
      throw new Error(`ArcGIS error ${body.error.code}: ${body.error.message}${body.error.details?.length ? ` (${body.error.details.join('; ')})` : ''}`);
    }

    const page = body.features ?? [];
    for (const f of page) {
      const key = (f.attributes ?? f)[keyField];
      if (key != null && key !== '') {
        if (seen.has(key)) continue;
        thisWindow.add(key);
      }
      features.push(f);
    }
    log.info(`  -> ${page.length} features (${features.length} total)`);

    // A layer whose maxRecordCount is below our page size returns short pages
    // with exceededTransferLimit set: keep paging, or the window is silently
    // cut at the first page. Stop on an empty page, or a short page with no
    // more to come.
    if (!page.length || (page.length < pageSize && !body.exceededTransferLimit)) break;
  }
  for (const k of thisWindow) seen.add(k);
  }

  // Hand the unmapped attributes to the caller for raw_records before mapping.
  if (onRaw) await onRaw(features.map((f) => f.attributes ?? f), { requests, truncated });
  return mapFeatures(features, source, { includeIssued, log });
}

/** Pure feature -> permit mapping, unit tested offline. */
function mapFeatures(features, source, { includeIssued = true, log }) {
  const map = source.fieldMap;
  const status = createStatusNormalizer({ statusMap: source.statusMap, label: source.label });
  const isEmpty = (v) => v == null || v === '' || Number(v) === 0;

  const permits = features.map((feature) => {
    const attrs = feature.attributes ?? feature;
    const pick = (key) => {
      const spec = map[key];
      if (!spec) return undefined;
      if (!Array.isArray(spec)) return attrs[spec];
      return spec.map((f) => attrs[f]).find((v) => !isEmpty(v));
    };

    const permitUrl = source.permitUrlTemplate && attrs[map.permitNumber]
      ? source.permitUrlTemplate.replace('{permitNumber}', encodeURIComponent(attrs[map.permitNumber]))
      : (map.permitUrl ? attrs[map.permitUrl] : null);

    // Some layers publish no status column at all — Miami-Dade records only
    // dates. A source may supply deriveStatus() to turn those into a stage.
    // This is an explicit, documented derivation rather than a guess about
    // wording that doesn't exist.
    const derived = source.deriveStatus ? source.deriveStatus(attrs) : null;
    const rawStatus = derived ? derived.statusRaw : pick('status');

    return normalizePermit({
      address: pick('address'),
      city: pick('city'),
      state: pick('state') ?? source.defaultState,
      zip: pick('zip'),
      jurisdiction: pick('jurisdiction') ?? source.label,
      permitType: pick('permitType'),
      workDescription: pick('workDescription'),
      valuation: pick('valuation'),
      status: derived ? derived.status : status.normalize(rawStatus),
      statusRaw: rawStatus,
      statusStage: derived ? derived.statusStage : undefined,
      permitUrl,
      permitNumber: pick('permitNumber'),
      // ArcGIS date fields come back as epoch milliseconds; normalizePermit's
      // toIsoDate() handles that shape directly.
      filedDate: pick('filedDate'),
      submittedOn: pick('submittedDate'),
      stageSince: pick('statusDate'),
      lifecycleStage: lifecycleStage(source, rawStatus, derived ? derived.statusStage : undefined),
      filingKind: source.filingKind || null,

      owner: pick('owner'),
      parcelNumber: pick('parcelNumber'),
      contractorName: pick('contractorName'),
      contractorPhone: pick('contractorPhone'),
      contractorLicence: pick('contractorLicence'),
      contractorTrade: pick('contractorTrade'),
      contractorCity: pick('contractorCity'),
    });
  });

  if (!source.deriveStatus) status.report(log);
  return includeIssued ? permits : permits.filter((p) => p.status !== 'issued');
}

module.exports = { fetchArcgisSource, mapFeatures, buildQueryUrl, buildWhere };
