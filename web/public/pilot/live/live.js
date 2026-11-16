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
  // Every pilot market (db/pilot_queries.js SOURCES); the server ignores any other value.
  const AREA = { 'austin-tx': 'Austin, TX', 'miami-dade-fl': 'Miami-Dade, FL', 'miami-city-fl': 'City of Miami, FL', 'raleigh-nc': 'Raleigh, NC' };
  const areaOf = (v) => (Object.prototype.hasOwnProperty.call(AREA, v) ? v : 'austin-tx');
  /** <option>s for a market picker, with `current` selected. */
  const areaOptions = (current) => Object.entries(AREA).map(([k, label]) => `<option value="${k}"${k === current ? ' selected' : ''}>${esc(label)}</option>`).join('');
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
    const why = `${p.verification === 'corroborated' ? 'Same number on 3+ permits, no other company' : 'Fewer than 3 permits or shared'}: on ${p.seenOnPermits} permit(s) for this company${shared}.`
      + ` Latest from permit ${p.sourceRef || '?'} (${p.source}), issued ${date(p.lastSeenOn)}. Nobody has called to check it.`;
    const href = window.telHref ? window.telHref(p.value) : null;
    const num = `<span class="phone mono prov" title="${esc(why)}">${phone(p.value)}</span>`;
    return (href ? `<a href="${esc(href)}" style="text-decoration:none">${num}</a>` : num)
      + ` <span class="pill prov ${p.verification === 'corroborated' ? 'ok' : ''}" title="${esc(why)}">${esc(p.verification === 'corroborated' ? 'on 3+ permits' : p.sharedWithOtherContractors ? 'shared number' : `on ${p.seenOnPermits} permit${p.seenOnPermits === 1 ? '' : 's'}`)}</span>`;
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

  // One shell for every screen. `current` is the page's own file name.
  const NAV = [['index.html', 'Overview'], ['early.html', 'Early filings'], ['momentum.html', 'Builder activity'], ['gcs.html', 'GC relationships'], ['digest.html', 'New permits'], ['/search.html', 'Permit search']];
  function topBar(current) {
    const here = current || location.pathname.split('/').pop() || 'index.html';
    return `<header class="top"><div class="top-in">
      <a class="wordmark" href="index.html"><i aria-hidden="true"></i>Giboro<small>pilot</small></a>
      <nav class="nav" aria-label="Screens">${NAV.map(([href, label]) => `<a href="${href}"${href === here ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
      <span class="top-meta"><span class="top-note">From public permit records, synced daily</span> <button type="button" class="tour-open" data-tour-open>Tour</button> <a class="signout" href="/logout">Sign out</a></span>
    </div></header>`;
  }

  /** Footer: the site's notices (web/legal.js PAGES), sources included; not the source list itself. */
  function attribution() {
    return '<div class="foot"><a href="/terms">Terms of use</a> <a href="/privacy">Privacy</a> <a href="/disclaimer">Disclaimer</a> <a href="/sources">Data sources</a> <a href="/contact">Contact &amp; removal</a></div>';
  }

  // ── Enrichment panels (ADR-15) ─────────────────────────────
  const num = (v, unit = '') => (v == null ? null : `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 })}${unit}`);

  /** Appraiser facts for the job's parcel, with the appraiser's credit. Missing reads as missing (rule 1). */
  function propertyCard(pr, area) {
    if (!pr) {
      return `<div class="card"><h2>The property</h2><p class="sub">No appraiser record joined to this permit${area === 'austin-tx' || area === 'miami-dade-fl' ? '' : ' (no appraiser source for this market yet)'}.</p></div>`;
    }
    const v = pr.provenance || {};
    const how = [`Matched by ${v.matchedBy || 'parcel id'}${pr.parcelId ? ` ${pr.parcelId}` : ''}`,
      `fetched ${dateTime(v.fetchedAt)}`, v.sourceEditedAt ? `appraiser record edited ${date(v.sourceEditedAt)}` : ''].filter(Boolean).join(', ');
    const cell = (x) => (x == null ? '<span class="sub">not recorded</span>' : `<span class="prov" title="${esc(how)}">${esc(x)}</span>`);
    const facts = [
      ['Land use', pr.landUse || pr.landUseCode],
      ['Year built', pr.yearBuilt],
      [pr.heatedSqft != null ? 'Heated area' : 'Building area', num(pr.heatedSqft ?? pr.buildingSqft, ' sq ft')],
      ['Lot', num(pr.lotSqft, ' sq ft')],
    ];
    const opt = [
      ['Units', num(pr.units)], ['Floors', num(pr.floors)], ['Bedrooms', num(pr.bedrooms)], ['Bathrooms', num(pr.bathrooms)],
      ['Improvement', pr.improvementType],
    ].filter(([, x]) => x != null);
    const values = [
      ['Assessed value', pr.assessedValueBand ? pr.assessedValueBand.label : null],
      ['Land value', pr.landValueBand ? pr.landValueBand.label : null],
      ['Improvement value', pr.improvementValueBand ? pr.improvementValueBand.label : null],
    ].filter(([, x]) => x != null);
    const dl = (rows) => rows.map(([k, x]) => `<dt>${esc(k)}</dt><dd>${cell(x)}</dd>`).join('');
    return `<div class="card prop">
      <h2>The property</h2>
      <dl class="kv">${dl(facts)}${dl(opt)}</dl>
      ${values.length ? `<h3 class="prop-h">${esc(pr.valueNote || (pr.assessmentYear ? `Appraisal, ${pr.assessmentYear} roll` : 'Appraisal'))}</h3><dl class="kv">${dl(values)}</dl>` : ''}
      <p class="note">Source: ${esc(v.attribution || v.source || 'appraiser')}. ${pr.parcelId ? `Parcel <span class="mono">${esc(pr.parcelId)}</span>. ` : ''}Owner, sale and exemption fields are not collected.</p>
    </div>`;
  }

  const PROVIDER = { 'fl-dbpr': 'Florida DBPR', 'tx-tdlr': 'Texas TDLR' };
  const MATCHED = { licence: 'licence number on its permits', phone: 'phone on its permits', name_state: 'business name in the state', name_state_active: 'business name in the state (the only active entity of several)' };

  /** State licence records matched to a business, with how each was matched and the file's credit. */
  function registryList(recs, { compact = false } = {}) {
    if (!recs || !recs.length) {
      return compact ? '' : '<p class="sub">No state licence record matched by licence number. Matches by name or phone alone are not shown.</p>';
    }
    const rows = recs.map((r) => {
      const st = r.status ? [r.status.primary, r.status.secondary].filter(Boolean).join(' / ') : null;
      const stLabel = st ? (r.provider === 'fl-dbpr' ? `DBPR status code ${st}` : `status ${st}`) : 'status not published';
      const exp = r.expiresOn
        ? (r.expired ? `<span class="pill bad">expired ${esc(date(r.expiresOn))}</span>` : `<span class="pill ok">valid to ${esc(date(r.expiresOn))}</span>`)
        : '<span class="pill">no expiry published</span>';
      const v = r.provenance || {};
      const how = `Matched by ${MATCHED[r.matchedBy] || r.matchedBy}, confidence ${pct(r.confidence)}. File dated ${date(v.fileDate)}, fetched ${dateTime(v.fetchedAt)}.`;
      return `<li class="lic">
        <div class="lic-row"><span class="prov" title="${esc(how)}"><b>${esc(PROVIDER[r.provider] || r.provider)}</b> <span class="mono">${esc(r.number)}</span></span>${exp}</div>
        <div class="sub">${esc([r.type, r.classCode].filter(Boolean).join(' · ') || 'type not published')} · ${esc(stLabel)} · matched by ${esc(MATCHED[r.matchedBy] || r.matchedBy)}</div>
      </li>`;
    }).join('');
    const credits = [...new Set(recs.map((r) => r.provenance && r.provenance.attribution).filter(Boolean))];
    const dbpr = recs.some((r) => r.provider === 'fl-dbpr');
    return `<ul class="lics">${rows}</ul>
      <p class="note">Source: ${esc(credits.join('; '))}.${dbpr ? ' Status codes are DBPR’s own, shown as published.' : ''} Tap or hover a licence for how it was matched.</p>`;
  }

  /**
   * State business registrations matched to a business (Texas franchise-tax
   * file): legal entity, Secretary of State file and right to transact, as
   * published. People (officers, registered agent) are not collected.
   */
  function registrationList(recs, { compact = false } = {}) {
    if (!recs || !recs.length) {
      return compact ? '' : '<p class="sub">No state business registration matched yet. We link only when exactly one registered entity has this exact name.</p>';
    }
    const rows = recs.map((r) => {
      const sunbiz = r.provider === 'fl-sunbiz';
      // Florida's file has no right-to-transact field; its status is the entity's own.
      const rt = sunbiz
        ? `<span class="pill ${/^active$/i.test(r.sosStatus || '') ? 'ok' : 'bad'}">Florida status: ${esc(r.sosStatus || 'not published')}</span>`
        : r.rightToTransact
          ? `<span class="pill ${/^active$/i.test(r.rightToTransact) ? 'ok' : 'bad'}">right to transact: ${esc(r.rightToTransact)}</span>`
          : '<span class="pill">right to transact not published</span>';
      const v = r.provenance || {};
      const how = `Matched by ${MATCHED[r.matchedBy] || r.matchedBy}, confidence ${pct(r.confidence)}. Fetched ${dateTime(v.fetchedAt)}.`;
      const facts = [
        !sunbiz && r.sosFileNumber && `SOS file ${r.sosFileNumber}`,
        r.stateOfFormation && `formed in ${r.stateOfFormation}`,
        r.registeredOn && `registered ${date(r.registeredOn)}`,
        !sunbiz && r.sosStatus && `SOS status ${r.sosStatus}`,
        r.reportYear && `last report ${r.reportYear}`,
        r.mailingCity && `mail ${[r.mailingCity, r.mailingState].filter(Boolean).join(', ')}`,
      ].filter(Boolean).join(' · ');
      return `<li class="lic">
        <div class="lic-row"><span class="prov" title="${esc(how)}"><b>${esc(r.legalName || 'Name not published')}</b>${r.dbaName ? ` <span class="sub">dba ${esc(r.dbaName)}</span>` : ''}</span>${rt}</div>
        <div class="sub">${sunbiz ? 'Sunbiz document' : 'Taxpayer'} <span class="mono">${esc(r.taxpayerId)}</span>${facts ? ` · ${esc(facts)}` : ''}</div>
      </li>`;
    }).join('');
    const credits = [...new Set(recs.map((r) => r.provenance && r.provenance.attribution).filter(Boolean))];
    return `<ul class="lics">${rows}</ul>
      <p class="note">Source: ${esc(credits.join('; ') || 'Texas Comptroller of Public Accounts')}. Officers and registered agent are not collected. Tap or hover the name for how it was matched.</p>`;
  }

  // ── Touch support ─────────────────────────────────────────
  // Provenance lives in title attributes (rule 6), which touch screens never
  // show. A tap on a dotted value opens the same text in a small panel.
  const noHover = window.matchMedia && window.matchMedia('(hover: none)').matches;
  let tip = null;
  function closeTip() { if (tip) { tip.remove(); tip = null; } }
  document.addEventListener('click', (e) => {
    if (!noHover) return;
    const el = e.target.closest && e.target.closest('.prov[title], .prov[data-title]');
    if (!el || el.closest('a, button')) { if (!(e.target.closest && e.target.closest('.tip'))) closeTip(); return; }
    e.preventDefault();
    const text = el.getAttribute('title') || el.dataset.title;
    // Keep the text off the title so the browser's own long-press tooltip doesn't double it.
    if (el.hasAttribute('title')) { el.dataset.title = text; el.removeAttribute('title'); }
    const same = tip && tip.dataset.for === text;
    closeTip();
    if (same) return;
    tip = document.createElement('div');
    tip.className = 'tip'; tip.setAttribute('role', 'status'); tip.dataset.for = text;
    tip.innerHTML = `<p>${esc(text)}</p><button type="button" aria-label="Close">Close</button>`;
    tip.querySelector('button').addEventListener('click', closeTip);
    document.body.appendChild(tip);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTip(); });

  // Tables with a header row become labelled cards on narrow screens
  // (live.css, table.stack): each cell carries its column name.
  function labelTables(root) {
    for (const t of root.querySelectorAll('table')) {
      const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
      if (heads.length < 3) continue;
      t.classList.add('stack');
      for (const tr of t.querySelectorAll('tbody tr')) {
        [...tr.children].forEach((td, i) => { if (heads[i] && !td.hasAttribute('data-label')) td.setAttribute('data-label', heads[i]); });
      }
    }
  }
  if (window.MutationObserver) {
    new MutationObserver(() => labelTables(document)).observe(document.documentElement, { childList: true, subtree: true });
  }

  // ── Estimates (ADR-21) ────────────────────────────────────
  // Anything we infer is marked with a dashed "estimate" tag and carries its
  // basis on hover or tap; facts from the record carry no tag.
  const estPill = (why) => `<span class="pill est prov" title="${esc(why)}">estimate</span>`;
  const shortDate = (d) => (d ? asDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—');
  /** "Dec 3 – Jan 20", or one date when both ends are the same day. */
  const dateRange = (a, b) => (a === b ? shortDate(a) : `${shortDate(a)} – ${shortDate(b)}`);

  const fail = (el, err) => { el.innerHTML = `<div class="state err">${esc(err.message)}</div>`; };

  // The GCs page and the New permits page rest on job links (ADR-33). While
  // the server hides them (/api/lens jobLinks false) each page is only an
  // explanation, so every link to them (nav, overview buttons and notes, map
  // popups, the tour steps that open them) is removed rather than leading to
  // an empty page. The pages still load by URL. The answer is kept for the
  // session so the next page hides them before it paints.
  const HIDDEN_PAGES = ['gcs.html', 'digest.html'];
  const LINK_SEL = HIDDEN_PAGES.flatMap((p) => [`a[href^="${p}"]`, `a[href^="/pilot/live/${p}"]`]).join(', ');
  const HIDE_KEY = 'ct_joblinks_hidden';
  const sget = (k) => { try { return sessionStorage.getItem(k); } catch (_e) { return null; } };
  const sset = (k, v) => { try { sessionStorage.setItem(k, v); } catch (_e) { /* private window */ } };
  let linksHidden = sget(HIDE_KEY) === '1';
  function dropLinks(scope) {
    for (const a of (scope || document).querySelectorAll(LINK_SEL)) {
      const p = a.parentElement;
      if (p && p.matches('p.note') && p.textContent.trim() === a.textContent.trim()) p.remove();
      else a.remove();
    }
  }
  function dropTourSteps() {
    const steps = window.Tour && window.Tour.STEPS;
    if (!steps) return;
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const target = String(steps[i].href || '').split('/').pop();
      if (HIDDEN_PAGES.includes(steps[i].page) || HIDDEN_PAGES.includes(target)) steps.splice(i, 1);
    }
  }
  function applyHidden() {
    dropLinks();
    dropTourSteps();
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches(LINK_SEL)) dropLinks(n.parentElement); else dropLinks(n); }
    }).observe(document.body, { childList: true, subtree: true });
  }
  function initHiddenLinks() {
    if (linksHidden) applyHidden();
    fetch('/api/lens', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cfg || typeof cfg.jobLinks !== 'boolean') return;
        const hide = !cfg.jobLinks;
        sset(HIDE_KEY, hide ? '1' : '0');
        if (hide && !linksHidden) { linksHidden = true; applyHidden(); }
        else if (!hide && linksHidden) location.reload(); // turned back on: show the links again
      })
      .catch(() => { /* keep what we had */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initHiddenLinks);
  else initHiddenLinks();

  window.Live = { esc, params, qs, api, date, dateTime, money, pct, daysSince, phone, who, phoneCell, freshness, topBar, attribution, fail, propertyCard, registryList, registrationList, labelTables, noHover, estPill, shortDate, dateRange, AREA, areaOf, areaOptions, TRADE, TRADE_PERSON };
}());
