// When the welcome pop-up ("What do you do?", web/public/lens.js) asks, like a
// cookie banner: on a browser's first visit; again once REASK_DAYS have passed
// since someone skipped it; never again after an answer. Each browser keeps its
// own record (localStorage), so a new phone or tablet is asked on its first
// visit. Pure: no DOM, no storage. Loads as a plain script or with require().
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WelcomeRule = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const REASK_DAYS = 7;
  const DAY_MS = 24 * 60 * 60 * 1000;

  /**
   * 'first' (never asked on this browser), 'again' (skipped long enough ago),
   * or null (don't ask). A skip with no readable date (saved before dates were
   * kept) counts as due.
   */
  function due(lens, now = Date.now(), days = REASK_DAYS) {
    if (!lens || typeof lens !== 'object') return 'first';
    if (!lens.skipped) return null;
    const at = Date.parse(lens.skippedAt || '');
    if (!Number.isFinite(at)) return 'again';
    return now - at >= days * DAY_MS ? 'again' : null;
  }

  return { REASK_DAYS, due };
}));
