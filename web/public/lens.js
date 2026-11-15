// The welcome popup and the "Your lens" button.
//
// "What do you do?" (one or more roles, each with its options: a trade, a
// supplier line) and "Where do you work?". The choices come from the server
// (/api/lens, web/lens_config.js), which also does the matching. The lens is
// kept in the URL (lens=sub.drywall,gc) and in localStorage, so a link carries
// it and a returning visitor keeps it. No account is needed.
//
// Trade matching is an inference, so it filters only where the server has
// SHOW_INFERENCES=1; elsewhere the popup says so and the lens sets the location.
// localStorage can throw (private windows): every access is guarded.
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KEY = 'contractos.lens.v1';
  const EXTRA = [['other', 'Something else', ''], ['all', 'Just show me everything', 'No lens: every permit we hold']];

  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
  const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* ignore */ } };

  let lens = read();
  let config = { roles: [], enabled: false };
  let index = null;
  let picker = null;

  /** "sub.drywall,gc" from the saved choices. */
  function paramOf(v) {
    if (!v || v.skipped) return '';
    const parts = [];
    for (const role of v.roles || []) {
      if (role === 'other' || role === 'all') continue;
      const opts = (v.options && v.options[role]) || [];
      if (opts.length) for (const o of opts) parts.push(`${role}.${o}`);
      else parts.push(role);
    }
    return parts.join(',');
  }
  // A lens saved before options existed ({ trades: ['Electrical', ...] }).
  function upgrade(v) {
    if (!v || v.options || !Array.isArray(v.trades)) return v;
    const sub = config.roles.find((r) => r.key === 'sub');
    const keys = sub ? v.trades.map((t) => (sub.options.find((o) => o.label.toLowerCase() === String(t).toLowerCase().split(' /')[0]) || {}).key).filter(Boolean) : [];
    const out = { ...v, options: { sub: keys } };
    delete out.trades;
    out.param = paramOf(out);
    return out;
  }

  const slot = document.getElementById('lensSlot');
  const dlg = document.createElement('dialog');
  dlg.className = 'welcome';
  dlg.id = 'welcome';
  dlg.setAttribute('aria-labelledby', 'welcomeTitle');
  document.body.appendChild(dlg);

  function build() {
    dlg.innerHTML = `
      <form class="welcome-body" method="dialog" novalidate>
        <div class="welcome-head">
          <h2 id="welcomeTitle">Welcome to Contractos</h2>
          <p>Tell us what you do and where, and we'll show the leads that fit. Optional, no signup.</p>
        </div>
        <fieldset class="welcome-q">
          <legend>What do you do? <small>Pick all that apply</small></legend>
          <div class="welcome-roles">
            ${config.roles.map((r) => `
              <div class="welcome-role-wrap">
                <label class="check welcome-role">
                  <input type="checkbox" name="role" value="${esc(r.key)}">
                  <span class="check-label">${esc(r.label)}<small>${esc(r.sub)}</small></span>
                </label>
                ${r.options.length ? `<div class="chips welcome-opts" data-for="${esc(r.key)}" hidden>
                  ${r.options.map((o) => `<button type="button" class="chip" data-role="${esc(r.key)}" data-opt="${esc(o.key)}" aria-pressed="false">${esc(o.label)}</button>`).join('')}
                </div>` : ''}
              </div>`).join('')}
            ${EXTRA.map(([k, label, sub]) => `
              <div class="welcome-role-wrap"><label class="check welcome-role">
                <input type="checkbox" name="role" value="${k}">
                <span class="check-label">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
              </label></div>`).join('')}
          </div>
          <input class="input welcome-other" name="otherText" type="text" maxlength="80"
                 placeholder="What do you do? (optional)" aria-label="Describe what you do" hidden>
        </fieldset>
        <fieldset class="welcome-q">
          <legend>Where do you work? <small>Pick one or more places</small></legend>
          <div id="welcomeLoc"></div>
        </fieldset>
        <p class="welcome-note">${config.enabled
          ? 'Your lens filters and ranks the leads, and each card says why it matched. Switch it off anytime with “Show everything”.'
          : 'Trade matching is not switched on for this site yet, so your lens sets the location; your trades are saved for when it is.'}</p>
        <div class="welcome-foot">
          <button type="button" class="btn btn-ghost" id="welcomeSkip">Skip for now</button>
          <button type="submit" class="btn btn-primary" id="welcomeGo">Show my leads</button>
        </div>
      </form>`;
    const form = dlg.querySelector('form');
    form.addEventListener('change', (e) => {
      if (e.target.name !== 'role') return;
      if (e.target.value === 'all' && e.target.checked) for (const b of boxes()) { if (b.value !== 'all') b.checked = false; }
      if (e.target.value !== 'all' && e.target.checked) form.querySelector('input[value="all"]').checked = false;
      paintConditional();
    });
    form.addEventListener('click', (e) => {
      const b = e.target.closest('[data-opt]');
      if (b) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); apply(save()); });
    dlg.querySelector('#welcomeSkip').addEventListener('click', () => { save({ skipped: true }); dlg.close(); paintButton(); });
    picker = window.LocationPicker.create(dlg.querySelector('#welcomeLoc'), { label: '', placeholder: 'Search an area, city or ZIP — e.g. Austin' });
    if (index) picker.setIndex(index);
  }
  dlg.addEventListener('cancel', () => { if (!lens) save({ skipped: true }); paintButton(); });

  const boxes = () => [...dlg.querySelectorAll('input[name="role"]')];
  const optBtns = () => [...dlg.querySelectorAll('[data-opt]')];

  function paintConditional() {
    const roles = boxes().filter((b) => b.checked).map((b) => b.value);
    for (const box of dlg.querySelectorAll('.welcome-opts')) box.hidden = !roles.includes(box.dataset.for);
    const other = dlg.querySelector('.welcome-other');
    if (other) other.hidden = !roles.includes('other');
  }

  function fill() {
    const cur = lens || {};
    for (const b of boxes()) b.checked = (cur.roles || []).includes(b.value);
    for (const b of optBtns()) b.setAttribute('aria-pressed', String(((cur.options || {})[b.dataset.role] || []).includes(b.dataset.opt)));
    const other = dlg.querySelector('.welcome-other');
    if (other) other.value = cur.other || '';
    paintConditional();
    if (picker) picker.setValue(window.Leads ? window.Leads.getAreas() : (cur.areas || []));
  }

  function open() {
    if (!dlg.firstChild) build();
    fill();
    if (!dlg.open) dlg.showModal();
    (boxes().find((b) => b.checked) || boxes()[0]).focus();
  }

  function save({ skipped = false } = {}) {
    if (skipped) {
      if (!lens) { lens = { v: 2, skipped: true, roles: [], options: {}, areas: [], param: '' }; write(lens); }
      return lens;
    }
    const roles = boxes().filter((b) => b.checked).map((b) => b.value);
    const options = {};
    for (const b of optBtns()) {
      if (b.getAttribute('aria-pressed') === 'true' && roles.includes(b.dataset.role)) (options[b.dataset.role] = options[b.dataset.role] || []).push(b.dataset.opt);
    }
    const other = dlg.querySelector('.welcome-other');
    lens = { v: 2, skipped: false, roles: roles.length ? roles : ['all'], options,
      other: roles.includes('other') && other ? other.value.trim().slice(0, 80) : '',
      areas: picker ? picker.getValue() : [], savedAt: new Date().toISOString() };
    lens.param = paramOf(lens);
    write(lens);
    return lens;
  }

  function apply(v) {
    dlg.close();
    if (window.Leads) window.Leads.apply({ areas: v.areas, lens: v.param });
    paintButton();
  }

  /** The header button: what the lens is, in a few words. */
  function summary() {
    if (!lens || lens.skipped) return null;
    const labels = [];
    for (const r of lens.roles || []) {
      const role = config.roles.find((x) => x.key === r);
      const opts = ((lens.options || {})[r] || []).map((k) => (role && role.options.find((o) => o.key === k) || {}).label).filter(Boolean);
      if (opts.length) labels.push(...opts);
      else if (role) labels.push(role.label.split(' / ')[0]);
      else if (r === 'all') labels.push('Everything');
      else if (r === 'other') labels.push('Other');
    }
    const what = labels.length ? `${labels[0]}${labels.length > 1 ? ` +${labels.length - 1}` : ''}` : 'Everything';
    const areas = window.Leads ? window.Leads.getAreas() : (lens.areas || []);
    const where = areas.length && window.LocationPicker
      ? `${window.LocationPicker.labelFor(areas[0], index).replace(/, [A-Z]{2}$/, '')}${areas.length > 1 ? ` +${areas.length - 1}` : ''}`
      : 'All areas';
    return { what, where };
  }

  function paintButton() {
    if (!slot) return;
    const s = summary();
    slot.removeAttribute('aria-hidden');
    slot.innerHTML = `<button type="button" class="lens-btn" id="lensBtn" aria-haspopup="dialog"
        title="${s ? 'Your lens: change what you do or where' : 'Set your lens: what you do and where'}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>
      <span class="lens-text">${s ? `<b>${esc(s.what)}</b><span class="lens-where"> · ${esc(s.where)}</span>` : 'Set your lens'}</span>
    </button>`;
    slot.querySelector('#lensBtn').addEventListener('click', open);
  }

  window.LensUI = { open, label: () => (summary() || {}).what || '', param: () => paramOf(lens) };

  paintButton();
  // ?welcome=1 asks again, ?welcome=0 never asks (checks); lens=1|0 is the old spelling.
  const qs = new URLSearchParams(location.search);
  const ask = qs.get('welcome') ?? (['0', '1'].includes(qs.get('lens')) ? qs.get('lens') : null);
  const cfgReady = fetch('/api/lens').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const areasReady = window.Leads ? window.Leads.areas : Promise.resolve(null);
  Promise.all([cfgReady, areasReady]).then(([cfg, idx]) => {
    if (cfg) config = cfg;
    index = idx;
    lens = upgrade(lens);
    if (lens) write(lens);
    if (picker && idx) picker.setIndex(idx);
    paintButton();
    // Ask on the first visit, on the Leads page only.
    const onLeads = location.pathname === '/' || location.pathname.startsWith('/search');
    if (ask === '1' || (!lens && ask !== '0' && onLeads)) open();
  });
  window.addEventListener('leads:areas', paintButton);
})();
