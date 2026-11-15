// Raw-record capture and sync-run bookkeeping helpers (ROADMAP M1).
//
// Every row a source returns is stored verbatim in raw_records, keyed by
// (source, source_key, sha256 of canonical JSON). Re-fetching unchanged rows is
// a no-op; a changed row adds a new version. Pure functions live here so they
// test offline; the SQL is in db/index.js.

const crypto = require('node:crypto');

/**
 * The source's own record-modification time, as an ISO timestamp, or null.
 * Read only from the column a source declares as one (`updatedAtField` in
 * src/sources.js). Socrata's system :updated_at is not used: Austin reloads
 * every row daily, so it would date a reload, not a change (CLAUDE.md rule 7).
 */
function sourceUpdatedAt(row, source) {
  const field = source.updatedAtField;
  if (!field || !row) return null;
  const v = row[field];
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v).trim().replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(\.\d+)?)$/, '$1T$2Z'));
  return Number.isNaN(d.getTime()) || Math.abs(d.getTime()) > 8.64e15 ? null : d.toISOString();
}

/** JSON with object keys sorted at every level, so hashing ignores key order. */
function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function payloadHash(payload) {
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * Turns adapter raw rows into raw_records candidates. The key is the source's
 * own permit number column (fieldMap.permitNumber). A row without one cannot be
 * deduplicated, so it is counted as failed instead of stored under a made-up key.
 *
 * @param {{recordUrls?: (string|null)[]}} [meta] the adapter's onRaw meta: recordUrls[i]
 *   re-fetches rows[i] from the source (raw_records.source_url)
 * @returns {{records: {sourceKey, payloadHash, payload, sourceUpdatedAt, sourceUrl}[], failed: number}}
 */
function toRawRecords(rows, source, { recordUrls = [] } = {}) {
  const keyField = source.fieldMap && source.fieldMap.permitNumber;
  if (!keyField || Array.isArray(keyField)) {
    throw new Error(`Source "${source.label}" has no single permitNumber field; raw records need a stable key`);
  }
  const byKeyAndHash = new Map();
  let failed = 0;
  for (const [i, row] of rows.entries()) {
    const key = row == null ? null : row[keyField];
    if (key == null || String(key).trim() === '') { failed += 1; continue; }
    const hash = payloadHash(row);
    const sourceKey = String(key).trim();
    // The same row twice in one fetch (overlapping pages) is stored once.
    byKeyAndHash.set(`${sourceKey}\u0000${hash}`, {
      sourceKey,
      payloadHash: hash,
      payload: row,
      sourceUpdatedAt: sourceUpdatedAt(row, source),
      sourceUrl: recordUrls[i] || null,
    });
  }
  return { records: [...byKeyAndHash.values()], failed };
}

/**
 * Maps an error to sync_runs.error_class. Anything unrecognised is 'unknown',
 * which is reported like any other failure (CLAUDE.md rule 3).
 */
function classifyError(err) {
  const msg = String((err && err.message) || err || '');
  const status = Number((msg.match(/HTTP (\d{3})/) || [])[1]);
  if (status === 429 || /rate limit|too many requests/i.test(msg)) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500 || /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|fetch failed|timeout/i.test(msg)) return 'transient';
  if (/fieldMap|no single permitNumber|schema|unknown column|no such column|Invalid field/i.test(msg)) return 'schema';
  if (/Unexpected token|JSON|invalid input syntax|violates/i.test(msg)) return 'bad_data';
  if (err instanceof TypeError || err instanceof ReferenceError) return 'bug';
  return 'unknown';
}

module.exports = { canonicalJson, payloadHash, toRawRecords, classifyError, sourceUpdatedAt };
