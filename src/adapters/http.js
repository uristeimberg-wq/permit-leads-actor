// Retry for transient HTTP failures, shared by the API adapters.
//
// A dropped connection or a 5xx/429 on page 7 of 10 used to fail the whole
// run (Miami-Dade's "fetch failed" at --max=6000 in the README). Retrying with
// backoff keeps the run; a 4xx other than 429 is a real error and is not
// retried. The final error still reaches sync_runs with its class.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * @param {Function} fetchImpl
 * @param {string} url
 * @param {object} [init]
 * @param {{attempts?: number, baseDelayMs?: number, log?: object, sleepImpl?: Function}} [opts]
 * @returns {Promise<Response>} the last response (ok or not) once retries are spent
 */
async function fetchWithRetry(fetchImpl, url, init, { attempts = 4, baseDelayMs = 1000, log, sleepImpl = sleep } = {}) {
  for (let i = 1; ; i += 1) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (err) {
      if (i >= attempts) throw err;
      if (log) log.warning(`  network error (${err.message}); retry ${i}/${attempts - 1}`);
      await sleepImpl(baseDelayMs * 2 ** (i - 1));
      continue;
    }
    if (response.ok || !RETRY_STATUS.has(response.status) || i >= attempts) return response;
    // Honour Retry-After (seconds) when the server sends one, capped at a minute.
    const retryAfter = Number(response.headers && response.headers.get && response.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60000) : baseDelayMs * 2 ** (i - 1);
    if (log) log.warning(`  HTTP ${response.status}; retry ${i}/${attempts - 1} in ${Math.round(wait / 1000)}s`);
    await sleepImpl(wait);
  }
}

module.exports = { fetchWithRetry, RETRY_STATUS };
