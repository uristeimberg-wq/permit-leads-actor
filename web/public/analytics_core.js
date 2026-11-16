// Product analytics: the pure parts, shared by the browser tracker
// (web/public/analytics.js) and the ingestion endpoint (web/telemetry.js), so
// the client and the server agree on the taxonomy and the redaction rules.
// No DOM, no network. Loads as a plain script (window.AnalyticsCore) or with
// require(). See docs/ANALYTICS.md.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AnalyticsCore = api;
}(typeof self !== 'undefined' ? self : this, () => {
  // The taxonomy: event name -> category. The server rejects any other name.
  const EVENTS = {
    // Navigation and attention
    page_view: 'navigation',
    page_exit: 'navigation',
    scroll_depth_reached: 'navigation',
    tab_switched: 'navigation',
    // Search and discovery
    search_executed: 'search',
    filter_applied: 'search',
    filter_cleared: 'search',
    sort_changed: 'search',
    pagination_clicked: 'search',
    // Records
    record_clicked: 'record_engagement',
    record_detail_viewed: 'record_engagement',
    external_source_link_clicked: 'record_engagement',
    // High-value actions
    contact_info_clicked: 'export_or_action',
    record_saved: 'export_or_action',
    record_unsaved: 'export_or_action',
    data_exported: 'export_or_action',
    alert_created: 'export_or_action',
    // Identity
    signup_started: 'auth',
    signup_completed: 'auth',
    login_succeeded: 'auth',
    logout: 'auth',
    // UI
    ui_click: 'ui_interaction',
    // The "What do you do?" welcome pop-up (web/public/lens.js)
    onboarding_completed: 'ui_interaction',
    onboarding_skipped: 'ui_interaction',
    // Friction
    ui_error_encountered: 'error',
    api_request_failed: 'error',
    rage_click_detected: 'error',
  };
  // The pop-up's role keys (web/lens_config.js). Anything else is dropped.
  const ROLES = ['sub', 'gc', 'supplier', 'other', 'all'];
  /**
   * What the visitor answered in the pop-up, from its saved lens: an array of
   * role keys, 'skipped', or null (not answered on this browser).
   */
  function lensRoles(lens) {
    if (!lens || typeof lens !== 'object') return null;
    if (lens.skipped) return 'skipped';
    const roles = Array.isArray(lens.roles) ? [...new Set(lens.roles.filter((r) => ROLES.includes(r)))].sort() : [];
    return roles.length ? roles : null;
  }
  const ENTITY_TYPES = ['permit', 'pre_approval', 'contractor', 'property', 'project'];
  const HIGH_INTENT = ['contact_info_clicked', 'record_saved', 'data_exported', 'alert_created'];

  // Keys whose values never get stored, whatever they hold.
  const SENSITIVE_KEY = /pass(word)?|secret|token|auth|cookie|session_?key|api_?key|credential|signature|^sig$|email|phone|^tel$|owner_?name/i;
  const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi;
  // North American numbers and +international: 10+ digits with optional separators,
  // not glued to other digits or letters (permit numbers like 2024-012345 BP do not match).
  // (No lookbehind: older Safari cannot parse it.)
  const PHONE = /(^|[^\w-])(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])/g;
  // Long opaque strings: JWTs, hex or base64 tokens.
  const TOKEN = /\b(?:eyJ[\w-]+\.[\w-]+\.[\w-]+|[a-f0-9]{32,}|[A-Za-z0-9_-]{40,})\b/g;

  const MAX_STRING = 200;
  const MAX_KEYS = 30;
  const MAX_ARRAY = 20;
  const MAX_DEPTH = 3;

  /** Free text with emails, phone numbers and tokens replaced, trimmed and capped. */
  function redactText(v, max = MAX_STRING) {
    if (v == null) return v;
    const s = String(v)
      .replace(EMAIL, '[email]')
      .replace(TOKEN, '[token]')
      .replace(PHONE, '$1[phone]')
      .replace(/\s+/g, ' ')
      .trim();
    return s.length > max ? s.slice(0, max) : s;
  }

  /**
   * A JSON-safe copy of `props` with sensitive keys dropped, strings redacted,
   * and size bounded. Non-finite numbers and functions are dropped.
   */
  function sanitizeProps(props, depth = 0) {
    if (props == null || typeof props !== 'object') return {};
    if (Array.isArray(props)) {
      return props.slice(0, MAX_ARRAY).map((v) => sanitizeValue(v, depth + 1)).filter((v) => v !== undefined);
    }
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(props)) {
      if (n >= MAX_KEYS) break;
      const key = String(k).slice(0, 48);
      if (!/^[A-Za-z][\w-]*$/.test(key) || SENSITIVE_KEY.test(key)) continue;
      const clean = sanitizeValue(v, depth + 1);
      if (clean === undefined) continue;
      out[key] = clean;
      n += 1;
    }
    return out;
  }
  function sanitizeValue(v, depth) {
    if (v === null) return null;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'string') return redactText(v);
    if (typeof v === 'object') return depth >= MAX_DEPTH ? undefined : sanitizeProps(v, depth);
    return undefined;
  }

  /**
   * Visible-time stopwatch. Time counts only while `visible`; pause() when the
   * tab is hidden, resume() when it is back.
   */
  function activeTimer({ now = () => Date.now(), visible = true } = {}) {
    let total = 0;
    let since = visible ? now() : null;
    return {
      pause() { if (since != null) { total += Math.max(0, now() - since); since = null; } },
      resume() { if (since == null) since = now(); },
      get running() { return since != null; },
      /** Active milliseconds so far. */
      elapsed() { return total + (since != null ? Math.max(0, now() - since) : 0); },
    };
  }

  /**
   * The in-memory event buffer. push() returns true when the batch is full
   * (the caller flushes). take() empties up to `maxBatch` events; giveBack()
   * returns a failed batch to the front, de-duplicated, within `maxQueue`.
   */
  function eventQueue({ maxBatch = 10, maxQueue = 200 } = {}) {
    let items = [];
    return {
      push(ev) {
        items.push(ev);
        if (items.length > maxQueue) items = items.slice(items.length - maxQueue);
        return items.length >= maxBatch;
      },
      take(n = maxBatch) { const out = items.slice(0, n); items = items.slice(n); return out; },
      giveBack(batch) {
        const have = new Set(items.map((e) => e.event_id));
        items = batch.filter((e) => !have.has(e.event_id)).concat(items).slice(0, maxQueue);
      },
      get size() { return items.length; },
    };
  }

  const SCROLL_MARKS = [25, 50, 75, 100];
  /** The scroll marks newly passed at `pct`, given the marks already sent. */
  function scrollMarks(pct, sent) {
    const out = [];
    for (const m of SCROLL_MARKS) if (pct >= m && !sent.has(m)) { sent.add(m); out.push(m); }
    return out;
  }
  /** Percent of a scroller seen: the bottom of the viewport over the content height. */
  function scrollPercent({ scrollTop, clientHeight, scrollHeight }) {
    if (!(scrollHeight > 0)) return 0;
    if (scrollHeight <= clientHeight) return 100;
    return Math.min(100, Math.round(((scrollTop + clientHeight) / scrollHeight) * 100));
  }

  /**
   * Rage clicks: `count` clicks within `windowMs` within `radius` px on an
   * element that did nothing (not a link, button or form control). click()
   * returns true once per burst.
   */
  function rageDetector({ now = () => Date.now(), count = 3, windowMs = 800, radius = 30 } = {}) {
    let clicks = [];
    let fired = false;
    return {
      click(x, y, responsive) {
        const t = now();
        if (responsive) { clicks = []; fired = false; return false; }
        clicks = clicks.filter((c) => t - c.t <= windowMs && Math.hypot(c.x - x, c.y - y) <= radius);
        if (!clicks.length) fired = false;
        clicks.push({ t, x, y });
        if (clicks.length >= count && !fired) { fired = true; return true; }
        return false;
      },
    };
  }

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function uuid() {
    const c = (typeof crypto !== 'undefined' && crypto) || null;
    if (c && c.randomUUID) return c.randomUUID();
    const b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  /** Session rule: a new session after 30 minutes without activity. */
  const SESSION_IDLE_MS = 30 * 60 * 1000;
  function sessionFor(stored, nowMs, make = uuid) {
    if (stored && UUID.test(stored.id) && nowMs - Number(stored.last) < SESSION_IDLE_MS) return { id: stored.id, last: nowMs, isNew: false };
    return { id: make(), last: nowMs, isNew: true };
  }

  return {
    EVENTS, ENTITY_TYPES, HIGH_INTENT, ROLES, lensRoles, SCROLL_MARKS, SESSION_IDLE_MS, UUID,
    redactText, sanitizeProps, activeTimer, eventQueue, scrollMarks, scrollPercent, rageDetector, uuid, sessionFor,
  };
}));
