// Shared helpers for the live pilot screens. All third-party text goes through
// esc() before innerHTML (CLAUDE.md rule 8).
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const params = () => Object.fromEntries(new URLSearchParams(location.search));
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  async function api(path) {
    const r = await fetch(path, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(r.status === 404 ? 'Not found' : `Request failed (${r.status})`);
    return r.json();
  }
  const asDate = (d) => new Date(String(d).length === 10 ? `${d}T12:00:00Z` : d);
  const date = (d) => (d ? asDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');
  const dateTime = (d) => (d ? new Date(d).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) : 'never');
  const money = (v) => (v == null ? 'not published' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
  const daysSince = (d) => (d ? Math.floor((Date.now() - asDate(String(d).slice(0, 10))) / 86400000) : null);
  function phone(e164) {
    const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
    return m ? `(${m[1]}) ${m[2]}-${m[3]}` : esc(e164);
  }
  const AREA = { 'austin-tx': 'Austin, TX', 'miami-dade-fl': 'Miami-Dade, FL' };
  const TRADE = { electrical: 'Electrical', mechanical: 'Mechanical', plumbing: 'Plumbing' };
  const TRADE_PERSON = { electrical: 'electricians', mechanical: 'HVAC contractors', plumbing: 'plumbers' };

  /** A contractor's name, or the withheld notice; linked to its profile when public. */
  function who(c) {
    if (!c) return '<span class="sub">none on record</span>';
    if (!c.name) return `<span class="sub prov" title="${esc(c.withheld)}">Individual (withheld)</span>`;
    return `<a href="contractor.html?id=${encodeURIComponent(c.id)}">${esc(c.name)}</a>`;
  }

  /** A displayable phone with its evidence on hover, or an explicit "none". */
  function phoneCell(p) {
    if (!p) return '<span class="sub">no phone we can show</span>';
    const shared = p.sharedWithOtherContractors
      ? `, also listed by ${p.sharedWithOtherContractors} other compan${p.sharedWithOtherContractors === 1 ? 'y' : 'ies'}` : '';
    const why = `${p.verification === 'corroborated' ? 'Corroborated' : 'Unverified'}: on ${p.seenOnPermits} permit(s) for this company${shared}.`
      + ` Latest from permit ${p.sourceRef || '?'} (${p.source}), issued ${date(p.lastSeenOn)}. Nobody has called to check it.`;
    const href = window.telHref ? window.telHref(p.value) : null;
    const num = `<span class="phone mono prov" title="${esc(why)}">${phone(p.value)}</span>`;
    return (href ? `<a href="${esc(href)}" style="text-decoration:none">${num}</a>` : num)
      + ` <span class="pill ${p.verification === 'corroborated' ? 'ok' : ''}">${esc(p.verification)}</span>`;
  }

  function freshness(meta) {
    if (!meta) return '';
    const stale = !meta.lastSyncAt || Date.now() - new Date(meta.lastSyncAt) > 36 * 3600000;
    return `<div class="fresh mono">
      <span class="${stale ? 'err' : ''}">Last sync ${esc(dateTime(meta.lastSyncAt))}${meta.lastSyncStatus === 'failed' ? ' · latest attempt failed' : ''}${stale ? ' · stale' : ''}</span>
      <span>${esc(meta.publicationLag)}</span>
      <span>Permits in our data: issued from about ${esc(date(meta.historyFrom))} to ${esc(date(meta.historyTo))}</span>
    </div>`;
  }

  function topBar() {
    return `<div class="top"><strong>Contractos Leads · pilot</strong>
      <a href="gcs.html">GC relationships</a><a href="digest.html">Weekly digest</a>
      <span style="margin-left:auto">Live data from public permit records</span></div>`;
  }

  function attribution(meta) {
    const src = meta && meta.source === 'miami-dade-fl'
      ? 'Miami-Dade County Open Data (ArcGIS building permits layer)'
      : 'City of Austin, Texas – data.austintexas.gov, dataset 3syk-w9eu';
    return `<div class="foot"><span>Source: ${esc(src)}. Contacts come from the public permit record; individuals are withheld.</span>
      <span>Spot something wrong? Tell your pilot contact.</span></div>`;
  }

  const fail = (el, err) => { el.innerHTML = `<div class="state err">${esc(err.message)}</div>`; };

  window.Live = { esc, params, qs, api, date, dateTime, money, pct, daysSince, phone, who, phoneCell, freshness, topBar, attribution, fail, AREA, TRADE, TRADE_PERSON };
}());
