// The welcome popup and the "Your lens" button (redesign step 2).
//
// First visit: "What do you do?" (one or more roles, and trades/services) and
// "Where do you work?" (the same location picker as the sidebar). The location
// is applied to the Leads filters straight away. Roles and trades are saved and
// shown in the header, but do not filter yet: matching permits to a trade needs
// a query agreed with the data side, so the popup says so rather than pretend.
//
// Saved per browser in localStorage (no accounts; the invite gate is unchanged).
// Storage can throw in a private window; the popup then just asks again.
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KEY = 'contractos.lens.v1';

  const ROLES = [
    ['sub', 'Subcontractor / trade', 'Electrical, plumbing, roofing and other trades'],
    ['gc', 'General contractor / builder', 'You run the job and hire the subs'],
    ['supplier', 'Supplier or equipment rental', 'Materials, dumpsters, equipment'],
    ['other', 'Something else', ''],
    ['all', 'Just show me everything', 'No lens: every permit we hold'],
  ];
  const SHORT = { sub: 'Trades', gc: 'GC', supplier: 'Supplier', other: 'Other', all: 'Everything' };
  const TRADES = [
    'Electrical', 'Plumbing', 'HVAC / Mechanical', 'Roofing', 'Flooring', 'Painting', 'Concrete',
    'Framing', 'Drywall', 'Excavation', 'Solar', 'Landscaping', 'Waste removal / dumpsters',
    'Building materials', 'General contracting', 'Other',
  ];

  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
  const write = (lens) => { try { localStorage.setItem(KEY, JSON.stringify(lens)); } catch { /* ignore */ } };

  let lens = read();
  let index = null;          // places, once /api/areas has loaded
  let picker = null;         // the popup's location picker

  const slot = document.getElementById('lensSlot');
  const dlg = document.createElement('dialog');
  dlg.className = 'welcome';
  dlg.id = 'welcome';
  dlg.setAttribute('aria-labelledby', 'welcomeTitle');
  dlg.innerHTML = `
    <form class="welcome-body" method="dialog" novalidate>
      <div class="welcome-head">
        <h2 id="welcomeTitle">Welcome to Contractos</h2>
        <p>Tell us what you do and where, and we'll set up your leads.</p>
      </div>

      <fieldset class="welcome-q">
        <legend>What do you do? <small>Pick all that apply</small></legend>
        <div class="welcome-roles">
          ${ROLES.map(([k, label, sub]) => `
            <label class="check welcome-role">
              <input type="checkbox" name="role" value="${k}">
              <span class="check-label">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
            </label>`).join('')}
        </div>
        <input class="input welcome-other" name="otherText" type="text" maxlength="80"
               placeholder="What do you do? (optional)" aria-label="Describe what you do" hidden>
      </fieldset>

      <fieldset class="welcome-q" id="welcomeTrades" hidden>
        <legend>Which trades or services? <small>Pick all that apply</small></legend>
        <div class="chips welcome-trades">
          ${TRADES.map((t) => `<button type="button" class="chip" data-trade="${esc(t)}" aria-pressed="false">${esc(t)}</button>`).join('')}
        </div>
      </fieldset>

      <fieldset class="welcome-q">
        <legend>Where do you work? <small>Pick one or more places</small></legend>
        <div id="welcomeLoc"></div>
      </fieldset>

      <p class="welcome-note">Today your lens sets the location. Matching permits to your
        trade is coming next; until then you see every permit in your area.</p>

      <div class="welcome-foot">
        <button type="button" class="btn btn-ghost" id="welcomeSkip">Skip for now</button>
        <button type="submit" class="btn btn-primary" id="welcomeGo">Show my leads</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);

  const form = dlg.querySelector('form');
  const roleBoxes = () => [...form.querySelectorAll('input[name="role"]')];
  const tradeBtns = () => [...form.querySelectorAll('[data-trade]')];
  const otherText = form.querySelector('.welcome-other');

  /** "Show me everything" excludes the rest, and the rest exclude it. */
  form.addEventListener('change', (e) => {
    if (e.target.name !== 'role') return;
    if (e.target.value === 'all' && e.target.checked) for (const b of roleBoxes()) { if (b.value !== 'all') b.checked = false; }
    if (e.target.value !== 'all' && e.target.checked) form.querySelector('input[value="all"]').checked = false;
    paintConditional();
  });
  form.querySelector('.welcome-trades').addEventListener('click', (e) => {
    const b = e.target.closest('[data-trade]');
    if (b) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
  });

  function paintConditional() {
    const roles = roleBoxes().filter((b) => b.checked).map((b) => b.value);
    document.getElementById('welcomeTrades').hidden = !(roles.includes('sub') || roles.includes('supplier'));
    otherText.hidden = !roles.includes('other');
  }

  function fill() {
    const cur = lens || {};
    for (const b of roleBoxes()) b.checked = (cur.roles || []).includes(b.value);
    for (const b of tradeBtns()) b.setAttribute('aria-pressed', String((cur.trades || []).includes(b.dataset.trade)));
    otherText.value = cur.other || '';
    paintConditional();
    // The location shown is what the screen is filtered to now.
    if (picker) picker.setValue(window.Leads ? window.Leads.getAreas() : (cur.areas || []));
  }

  function open() {
    fill();
    if (!dlg.open) dlg.showModal();
    const first = roleBoxes().find((b) => b.checked) || roleBoxes()[0];
    first.focus();
  }

  function save({ skipped = false } = {}) {
    const roles = roleBoxes().filter((b) => b.checked).map((b) => b.value);
    const trades = tradeBtns().filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.trade);
    const areas = picker ? picker.getValue() : [];
    lens = skipped && !lens
      ? { v: 1, skipped: true, roles: [], trades: [], other: '', areas: [], savedAt: new Date().toISOString() }
      : { v: 1, skipped: false, roles: roles.length ? roles : ['all'],
          trades: (roles.includes('sub') || roles.includes('supplier')) ? trades : [],
          other: roles.includes('other') ? otherText.value.trim().slice(0, 80) : '',
          areas, savedAt: new Date().toISOString() };
    write(lens);
    return areas;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const areas = save();
    dlg.close();
    if (window.Leads) window.Leads.setAreas(areas);
    paintButton();
  });
  document.getElementById('welcomeSkip').addEventListener('click', () => { save({ skipped: true }); dlg.close(); paintButton(); });
  // Esc is "skip for now": never ask again unprompted, the button reopens it.
  dlg.addEventListener('cancel', () => { if (!lens) save({ skipped: true }); paintButton(); });

  /** The header button: what the lens is, in a few words. */
  function summary() {
    if (!lens || lens.skipped) return null;
    const what = lens.trades && lens.trades.length
      ? `${lens.trades[0]}${lens.trades.length > 1 ? ` +${lens.trades.length - 1}` : ''}`
      : (lens.roles || []).map((r) => SHORT[r]).filter(Boolean).slice(0, 2).join(', ') || 'Everything';
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

  paintButton();

  // The picker needs the places; app.js loads them once for both.
  picker = window.LocationPicker.create(document.getElementById('welcomeLoc'), {
    label: '', placeholder: 'Search an area, city or ZIP — e.g. Austin',
  });
  const ready = window.Leads ? window.Leads.areas : Promise.resolve(null);
  ready.then((idx) => {
    index = idx;
    if (idx) picker.setIndex(idx);
    paintButton();
    if (dlg.open) fill();
  });

  // Ask on the first visit. ?lens=1 asks again; ?lens=0 never asks (for checks).
  const ask = new URLSearchParams(location.search).get('lens');
  // Not on the Saved page: someone there already knows what they're after.
  if (ask === '1' || (!lens && ask !== '0' && location.pathname !== '/saved')) open();

  // The location chip, map pins and Clear all change the location: keep the
  // header button in step.
  window.addEventListener('leads:areas', paintButton);
})();
