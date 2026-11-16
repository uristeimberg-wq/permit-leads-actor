// Product analytics: the browser tracker (docs/ANALYTICS.md, ADR-37).
//
// Never in the way: events go into an in-memory queue and leave in batches
// (every 5 s, or at 10 events) with fetch keepalive, and with sendBeacon when
// the tab is hidden or closed. Nothing here is awaited by the app, and every
// call is wrapped so a tracker fault can never break a screen.
//
// Off entirely when the browser sends Do Not Track or Global Privacy Control,
// or the visitor opted out on /privacy. The device id is a random UUID in
// localStorage (first-party, never shared). Owner traffic is marked internal.
//
// Declarative: any element with data-track="<event or label>" is tracked on
// click, with data-track-id / -type / -pos / -label for the record, entity,
// list position and label. Programmatic: window.Track.event(name, props, ctx).
(function () {
  const C = window.AnalyticsCore;
  const noop = () => {};
  const NOOP = { event: noop, recordOpen: noop, recordClose: noop, identify: noop, flush: noop, enabled: false };
  if (!C) { window.Track = NOOP; return; }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: memory only */ } },
  };
  const optedOut = () => navigator.doNotTrack === '1' || window.doNotTrack === '1'
    || navigator.globalPrivacyControl === true || store.get('ct_analytics_optout') === '1';
  if (optedOut()) { window.Track = NOOP; return; }

  const ENDPOINT = '/api/telemetry/events';
  const FLUSH_MS = 5000;

  let deviceId = store.get('ct_device');
  if (!C.UUID.test(deviceId || '')) { deviceId = C.uuid(); store.set('ct_device', deviceId); }
  let stored = null;
  try { stored = JSON.parse(store.get('ct_session') || 'null'); } catch { stored = null; }
  let session = C.sessionFor(stored, Date.now());
  const touch = () => {
    session = C.sessionFor(session, Date.now());
    store.set('ct_session', JSON.stringify({ id: session.id, last: session.last }));
  };
  touch();

  // Where this session came from: another site's host only, and UTM tags.
  const params = new URLSearchParams(location.search);
  let refHost = null;
  try { const r = document.referrer && new URL(document.referrer); if (r && r.host !== location.host) refHost = r.host; } catch { refHost = null; }
  const origin = {
    entry_path: location.pathname,
    referrer: refHost,
    utm_source: params.get('utm_source'),
    utm_medium: params.get('utm_medium'),
    utm_campaign: params.get('utm_campaign'),
  };

  const queue = C.eventQueue({ maxBatch: 10, maxQueue: 200 });
  let sending = false;

  function payload(events) {
    return JSON.stringify({
      session_id: session.id,
      anonymous_device_id: deviceId,
      internal: store.get('ct_internal') === '1',
      session: origin,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      events,
    });
  }

  /** Send what is queued. `beacon` for the last chance before the page goes. */
  function flush({ beacon = false } = {}) {
    try {
      if (!queue.size) return;
      if (beacon && navigator.sendBeacon) {
        while (queue.size) {
          const batch = queue.take();
          const ok = navigator.sendBeacon(ENDPOINT, new Blob([payload(batch)], { type: 'application/json' }));
          if (!ok) { queue.giveBack(batch); break; }
        }
        return;
      }
      if (sending) return;
      const batch = queue.take();
      sending = true;
      fetch(ENDPOINT, {
        method: 'POST', keepalive: true, credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: payload(batch),
      }).then((r) => {
        // 4xx is a bad batch: retrying would fail again. 5xx and network: retry.
        if (r.status >= 500) queue.giveBack(batch);
      }, () => queue.giveBack(batch)).finally(() => { sending = false; });
    } catch { /* never break the page */ }
  }
  setInterval(() => flush(), FLUSH_MS);

  const pagePath = () => location.pathname.slice(0, 300);
  /** Record one event. ctx: target_record_id, target_entity_type, element_id, element_label. */
  function event(name, props = {}, ctx = {}) {
    try {
      if (!C.EVENTS[name]) return;
      touch();
      const full = queue.push({
        event_id: C.uuid(),
        event_name: name,
        client_timestamp: new Date().toISOString(),
        page_path: pagePath().replace(/[\s?#]/g, ''),
        page_title: document.title.slice(0, 200),
        element_id: ctx.element_id || null,
        element_label: ctx.element_label ? C.redactText(ctx.element_label, 120) : null,
        target_record_id: ctx.target_record_id != null && ctx.target_record_id !== ''
          ? String(ctx.target_record_id).replace(/[^\w.:-]+/g, '-').slice(0, 100) : null,
        target_entity_type: C.ENTITY_TYPES.includes(ctx.target_entity_type) ? ctx.target_entity_type : null,
        properties: C.sanitizeProps({ ...props, view_id: props.view_id || viewId }),
      });
      if (full) flush();
    } catch { /* never break the page */ }
  }

  // ── Page view and active dwell (Page Visibility API) ─────────────────────
  const viewId = C.uuid();
  const visible = () => document.visibilityState !== 'hidden';
  const pageTimer = C.activeTimer({ visible: visible() });
  // Pages that are one record, so the view counts against it.
  const RECORD_PAGES = { '/pilot/live/job.html': 'permit', '/pilot/live/contractor.html': 'contractor' };
  const pageRecord = RECORD_PAGES[location.pathname] && params.get('id')
    ? { target_entity_type: RECORD_PAGES[location.pathname], target_record_id: params.get('id') } : {};
  // The answer to the "What do you do?" pop-up, so visitors can be compared by role.
  const lensRoles = () => { try { return C.lensRoles(JSON.parse(store.get('contractos.lens.v1') || 'null')); } catch { return null; } };
  event('page_view', { session_start: session.isNew, view_id: viewId, lens_roles: lensRoles() }, pageRecord);

  let openRecord = null;   // { type, id, timer, props }
  function recordOpen(type, id, props = {}) {
    try {
      recordClose();
      if (id == null) return;
      openRecord = { type, id: String(id), timer: C.activeTimer({ visible: visible() }), props };
    } catch { /* never break the page */ }
  }
  function recordClose() {
    try {
      if (!openRecord) return;
      const r = openRecord;
      openRecord = null;
      event('record_detail_viewed', { ...r.props, read_time_ms: Math.round(r.timer.elapsed()) },
        { target_entity_type: r.type, target_record_id: r.id });
    } catch { /* never break the page */ }
  }

  function exitCheckpoint(final) {
    if (final) recordClose();
    event('page_exit', { dwell_time_ms: Math.round(pageTimer.elapsed()), final, view_id: viewId }, pageRecord);
    flush({ beacon: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (visible()) {
      pageTimer.resume();
      if (openRecord) openRecord.timer.resume();
    } else {
      pageTimer.pause();
      if (openRecord) openRecord.timer.pause();
      exitCheckpoint(false);
    }
  });
  window.addEventListener('pagehide', () => { pageTimer.pause(); exitCheckpoint(true); });

  // ── Scroll depth: the window, or the element marked data-track-scroll ────
  const marks = new Set();
  let scrollQueued = false;
  document.addEventListener('scroll', (e) => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      try {
        const t = e.target;
        const el = t === document || t === document.documentElement ? document.scrollingElement
          : (t && t.closest && t.closest('[data-track-scroll]'));
        if (!el) return;
        for (const m of C.scrollMarks(C.scrollPercent(el), marks)) event('scroll_depth_reached', { percent: m, scroller: el.id || 'page' });
      } catch { /* never break the page */ }
    });
  }, { capture: true, passive: true });

  // ── Clicks: declarative tracking, outbound links, contacts, rage ─────────
  const rage = C.rageDetector();
  const RESPONSIVE = 'a,button,input,select,textarea,label,summary,option,[role=button],[role=tab],[data-track],[tabindex],[contenteditable]';
  const labelOf = (el) => el.getAttribute('data-track-label') || el.getAttribute('aria-label')
    || ((el.tagName === 'BUTTON' || el.tagName === 'A') && el.textContent.trim().length <= 40 ? el.textContent.trim() : null);
  document.addEventListener('click', (e) => {
    try {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      if (rage.click(e.clientX, e.clientY, Boolean(t.closest(RESPONSIVE)))) {
        event('rage_click_detected', { tag: t.tagName.toLowerCase() }, { element_id: t.id || null });
      }
      const holder = t.closest('[data-track-id]');
      const record = holder ? { target_record_id: holder.getAttribute('data-track-id'), target_entity_type: holder.getAttribute('data-track-type') || null } : {};

      const pill = t.closest('a.phone-pill');
      if (pill) {
        const coarse = matchMedia('(hover: none), (pointer: coarse)').matches;
        event('contact_info_clicked', { method: coarse ? 'call' : 'copy', channel: 'phone' }, record);
        return;
      }
      const tracked = t.closest('[data-track]');
      if (tracked) {
        const name = tracked.getAttribute('data-track');
        const pos = Number(tracked.getAttribute('data-track-pos'));
        const props = Number.isFinite(pos) && pos > 0 ? { position: pos } : {};
        const ctx = { ...record, element_id: tracked.id || name.slice(0, 100), element_label: labelOf(tracked) };
        if (C.EVENTS[name] && name !== 'page_view' && name !== 'page_exit') event(name, props, ctx);
        else event('ui_click', { ...props, target: name.slice(0, 100) }, ctx);
      }
      const link = t.closest('a[href]');
      if (link && !pill) {
        let url = null;
        try { url = new URL(link.href, location.href); } catch { url = null; }
        if (url && /^https?:$/.test(url.protocol) && url.host !== location.host) {
          event('external_source_link_clicked', { host: url.host }, record);
          flush({ beacon: true });
        }
      }
    } catch { /* never break the page */ }
  }, { capture: true, passive: true });

  // ── Errors ────────────────────────────────────────────────────────────────
  let errors = 0;
  const fileOf = (s) => String(s || '').split('?')[0].split('/').pop().slice(0, 80) || null;
  window.addEventListener('error', (e) => {
    if (errors++ >= 5) return;
    event('ui_error_encountered', { message: String(e.message || 'error').slice(0, 200), file: fileOf(e.filename), line: e.lineno || null });
  });
  window.addEventListener('unhandledrejection', (e) => {
    if (errors++ >= 5) return;
    const r = e.reason;
    event('ui_error_encountered', { message: String((r && r.message) || r || 'rejection').slice(0, 200), kind: 'promise' });
  });

  window.Track = {
    enabled: true,
    event,
    recordOpen,
    recordClose,
    /** After a sign-in: send now, so the server links this device to the user at once. */
    identify(kind) { event(kind === 'signup' ? 'signup_completed' : 'login_succeeded'); flush(); },
    flush,
  };
}());
