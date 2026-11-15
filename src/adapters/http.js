// Retry for transient HTTP failures, shared by the API adapters.
//
// A dropped connection or a 5xx/429 on page 7 of 10 used to fail the whole
// run (Miami-Dade's "fetch failed" at --max=6000 in the README). Retrying with
// backoff keeps the run; a 4xx other than 429 is a real error and is not
// retried. The final error still reaches sync_runs with its class.
//
// Backoff is exponential with jitter (a random 50-100% of the step), so two
// jobs that failed together do not retry in lockstep. A Retry-After header,
// in seconds or as an HTTP date, is honoured up to a minute. Every retry is
// reported to `onRetry`, so a run can record how often a source pushed back
// (source_events 'rate_limited', ingest/run.js) instead of only logging it.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_WAIT_MS = 60000;

/** Retry-After as milliseconds, or null. Accepts delta-seconds or an HTTP date. */
function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * @param {Function} fetchImpl
 * @param {string} url
 * @param {object} [init]
 * @param {{attempts?: number, baseDelayMs?: number, log?: object, sleepImpl?: Function,
 *          randomImpl?: Function, onRetry?: Function}} [opts]
 *   onRetry({attempt, status, error, waitMs}) is called before each retry.
 * @returns {Promise<Response>} the last response (ok or not) once retries are spent
 */
async function fetchWithRetry(fetchImpl, url, init, {
  attempts = 4, baseDelayMs = 1000, log, sleepImpl = sleep, randomImpl = Math.random, onRetry,
} = {}) {
  const backoff = (i) => Math.round(baseDelayMs * 2 ** (i - 1) * (0.5 + 0.5 * randomImpl()));
  for (let i = 1; ; i += 1) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (err) {
      if (i >= attempts) throw err;
      const waitMs = backoff(i);
      if (onRetry) onRetry({ attempt: i, status: null, error: err.message, waitMs });
      if (log) log.warning(`  network error (${err.message}); retry ${i}/${attempts - 1}`);
      await sleepImpl(waitMs);
      continue;
    }
    if (response.ok || !RETRY_STATUS.has(response.status) || i >= attempts) return response;
    const header = retryAfterMs(response.headers && response.headers.get && response.headers.get('retry-after'));
    const waitMs = header != null && header > 0 ? Math.min(header, MAX_WAIT_MS) : backoff(i);
    if (onRetry) onRetry({ attempt: i, status: response.status, error: null, waitMs });
    if (log) log.warning(`  HTTP ${response.status}; retry ${i}/${attempts - 1} in ${Math.round(waitMs / 1000)}s`);
    await sleepImpl(waitMs);
  }
}

/** A counter for onRetry, summarised into one source event per run. */
function retryTally() {
  const tally = { retries: 0, rateLimited: 0, serverErrors: 0, networkErrors: 0, waitedMs: 0 };
  tally.onRetry = ({ status, waitMs }) => {
    tally.retries += 1;
    tally.waitedMs += waitMs;
    if (status === 429) tally.rateLimited += 1;
    else if (status == null) tally.networkErrors += 1;
    else tally.serverErrors += 1;
  };
  return tally;
}

module.exports = { fetchWithRetry, retryAfterMs, retryTally, RETRY_STATUS };
