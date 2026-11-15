// Location picker for the Leads screen and the welcome popup: one search box,
// several places at once. No framework; exposes window.LocationPicker.
//
// Places come from /api/areas and share the map's key vocabulary:
//   a:TX            a broad area (one per market, web/areas.js regionsFrom)
//   c:AUSTIN|TX     a city
//   z:78704         a ZIP code
// The picker only offers places we hold permits for. A key it doesn't know
// (an old link, a map pin) still shows as a chip and can be removed.
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const titleCase = (v) => String(v || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const n = (v) => Number(v || 0).toLocaleString('en-US');

  /** Every offerable place, busiest first within each kind. */
  function buildIndex(areas) {
    const items = [];
    for (const r of areas.regions || []) {
      items.push({ key: r.key, kind: 'area', label: r.label, sub: 'Whole area', permits: r.permits });
    }
    for (const c of areas.cities || []) {
      if (!c.city || !c.state) continue;
      items.push({ key: `c:${String(c.city).toUpperCase()}|${String(c.state).toUpperCase()}`, kind: 'city',
        label: `${titleCase(c.city)}, ${String(c.state).toUpperCase()}`, sub: 'City', permits: c.permits });
    }
    for (const z of areas.zips || []) {
      items.push({ key: `z:${z.zip}`, kind: 'zip', label: z.zip,
        sub: [titleCase(z.city), z.state].filter(Boolean).join(', '), permits: z.permits });
    }
    items.sort((a, b) => b.permits - a.permits);
    for (const it of items) it.hay = `${it.label} ${it.sub} ${it.key}`.toLowerCase();
    return { items, byKey: new Map(items.map((it) => [it.key, it])) };
  }

  /** A readable name for any key, known to the index or not. */
  function labelFor(key, index) {
    const it = index && index.byKey.get(key);
    if (it) return it.label;
    if (key.startsWith('z:')) return key.slice(2);
    if (key.startsWith('c:')) {
      const [city, state] = key.slice(2).split('|');
      return [titleCase(city), state].filter(Boolean).join(', ');
    }
    if (key.startsWith('a:')) return `${key.slice(2)} area`;
    return key;
  }

  /** A flat list (e.g. permit types) as an index: the row's own text is the key. */
  function buildListIndex(rows, { kind = 'item', key = 'key', label = 'label', count = 'permits' } = {}) {
    const items = rows.filter((r) => r[key]).map((r) => ({
      key: String(r[key]), kind, label: String(r[label] ?? r[key]), sub: '', permits: Number(r[count] || 0),
    }));
    items.sort((a, b) => b.permits - a.permits);
    for (const it of items) it.hay = it.label.toLowerCase();
    return { items, byKey: new Map(items.map((it) => [it.key, it])) };
  }

  // Groups to list: kind, heading, heading when nothing is typed, how many to
  // show with nothing typed, and how many while searching.
  const LOCATION_GROUPS = [
    { kind: 'area', title: 'Areas', idleTitle: 'Areas', idle: 10, max: 10 },
    { kind: 'city', title: 'Cities', idleTitle: 'Busiest cities', idle: 5, max: 8 },
    { kind: 'zip', title: 'ZIP codes', idleTitle: 'Busiest ZIP codes', idle: 6, max: 8 },
  ];

  let seq = 0;

  /**
   * @param {HTMLElement} root  an empty element to render into
   * @param {{label?: string, placeholder?: string, onChange?: (keys: string[]) => void,
   *          groups?: object[], noun?: string}} opts
   *   groups: what to list (default: areas, cities, ZIPs); noun: for the empty message
   */
  function create(root, opts = {}) {
    const id = `loc${++seq}`;
    const groupsDef = opts.groups || LOCATION_GROUPS;
    const noun = opts.noun || 'place we cover';
    let index = { items: [], byKey: new Map() };
    let value = [];
    let active = -1;       // index into the visible options, for the keyboard
    let visible = [];      // the options currently listed

    root.classList.add('loc');
    root.innerHTML = `
      ${opts.label ? `<label class="loc-label" for="${id}-q">${esc(opts.label)}</label>` : ''}
      <div class="loc-field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input class="input loc-input" id="${id}-q" type="text" autocomplete="off" spellcheck="false"
               role="combobox" aria-expanded="false" aria-controls="${id}-list" aria-autocomplete="list"
               placeholder="${esc(opts.placeholder || 'Search an area, city or ZIP')}">
      </div>
      <div class="loc-list" id="${id}-list" role="listbox" aria-multiselectable="true" aria-label="${esc(opts.listLabel || 'Places')}" hidden></div>
      <div class="loc-chips" aria-label="Selected"></div>`;
    const input = root.querySelector('.loc-input');
    const list = root.querySelector('.loc-list');
    const chips = root.querySelector('.loc-chips');

    const isOpen = () => !list.hidden;
    function open() { if (!isOpen()) { list.hidden = false; input.setAttribute('aria-expanded', 'true'); } renderList(); }
    // Closing clears the search text: the chips, not the box, say what is chosen.
    function close() { list.hidden = true; input.value = ''; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; }

    function matches(q) {
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      const pick = (kind, max) => index.items.filter((it) => it.kind === kind && terms.every((t) => it.hay.includes(t))).slice(0, max);
      return groupsDef.map((g) => [g, pick(g.kind, terms.length ? g.max : g.idle)]);
    }

    function renderList() {
      const q = input.value.trim();
      const groups = matches(q);
      visible = [];
      let html = '';
      for (const [g, rows] of groups) {
        if (!rows.length) continue;
        html += `<div class="loc-group" role="presentation">${esc(q ? g.title : g.idleTitle || g.title)}</div>`;
        for (const it of rows) {
          const i = visible.push(it) - 1;
          const on = value.includes(it.key);
          html += `<div class="loc-opt${i === active ? ' is-active' : ''}" role="option" id="${id}-o${i}" data-i="${i}" aria-selected="${on}">
            <span class="loc-box" aria-hidden="true">${on ? '✓' : ''}</span>
            <span class="loc-name">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>
            <span class="loc-n">${n(it.permits)}</span></div>`;
        }
      }
      list.innerHTML = html || `<div class="loc-empty">No ${esc(noun)} matches “${esc(q)}”.</div>`;
      if (active >= 0 && visible[active]) input.setAttribute('aria-activedescendant', `${id}-o${active}`);
      else input.removeAttribute('aria-activedescendant');
    }

    function renderChips() {
      chips.innerHTML = value.map((k) => `<button type="button" class="chip loc-chip" data-key="${esc(k)}"
        aria-label="Remove ${esc(labelFor(k, index))}">${esc(labelFor(k, index))}<span aria-hidden="true">×</span></button>`).join('');
      chips.hidden = !value.length;
    }

    function setValue(keys, { silent = true } = {}) {
      value = [...new Set(keys || [])];
      renderChips();
      if (isOpen()) renderList();
      if (!silent && opts.onChange) opts.onChange([...value]);
    }

    function toggle(key) {
      setValue(value.includes(key) ? value.filter((k) => k !== key) : [...value, key], { silent: false });
    }

    input.addEventListener('focus', open);
    input.addEventListener('click', open);
    input.addEventListener('input', () => { active = -1; open(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen()) open();
        if (!visible.length) return;
        active = e.key === 'ArrowDown' ? (active + 1) % visible.length : (active <= 0 ? visible.length - 1 : active - 1);
        renderList();
        const el = list.querySelector(`#${id}-o${active}`);
        if (el) el.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        // Enter picks the highlighted place, or the first match while typing.
        e.preventDefault();
        const it = visible[active >= 0 ? active : 0];
        if (isOpen() && it) toggle(it.key);
      } else if (e.key === 'Escape') {
        if (isOpen()) { e.stopPropagation(); e.preventDefault(); close(); }
      } else if (e.key === 'Backspace' && !input.value && value.length) {
        toggle(value[value.length - 1]);
      }
    });
    // pointerdown, not click: keep focus in the input so the list stays open
    // while several places are picked.
    list.addEventListener('pointerdown', (e) => e.preventDefault());
    list.addEventListener('click', (e) => {
      const opt = e.target.closest('.loc-opt');
      if (!opt) return;
      active = Number(opt.dataset.i);
      toggle(visible[active].key);
      input.focus();
    });
    chips.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-key]');
      if (chip) toggle(chip.dataset.key);
    });
    document.addEventListener('pointerdown', (e) => { if (isOpen() && !root.contains(e.target)) close(); });
    root.addEventListener('focusout', (e) => { if (!root.contains(e.relatedTarget)) close(); });

    renderChips();
    return {
      setIndex(next) { index = next || index; renderChips(); if (isOpen()) renderList(); },
      setValue,
      getValue: () => [...value],
      focus: () => input.focus(),
      close,
    };
  }

  window.LocationPicker = { create, buildIndex, buildListIndex, labelFor };
})();
