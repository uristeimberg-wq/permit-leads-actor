/* Link guards for third-party values (permit portals, contractor phones).
 *
 * esc() stops markup injection but not a hostile URL: a source could publish
 * `javascript:...` as a permit link and esc() would pass it through. These
 * helpers return a value that is safe to put in an href, or null.
 *
 * Loaded by index.html before app.js; also required by links.test.js in Node.
 */
(function (root) {
  // Only absolute http(s) URLs. Anything else (javascript:, data:, relative
  // paths, protocol-relative //host) is refused.
  function safeHttpUrl(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!/^https?:\/\//i.test(s)) return null;
    try {
      const u = new URL(s);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch {
      return null;
    }
  }

  // tel: href built from digits only, so no other characters reach the link.
  // US numbers with 10 digits (or 11 starting with 1) become +1XXXXXXXXXX.
  function telHref(value) {
    if (value === null || value === undefined) return null;
    const d = String(value).replace(/\D/g, '');
    if (d.length === 10) return `tel:+1${d}`;
    if (d.length === 11 && d[0] === '1') return `tel:+${d}`;
    return null;
  }

  const api = { safeHttpUrl, telHref };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
