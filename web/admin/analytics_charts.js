// Trend charts on the owner's analytics dashboard. Data: /api/admin/analytics/charts
// (web/admin_charts.js), real SQL aggregates only. Drawing: Chart.js, served
// from node_modules. Each chart has a table view under it.
(function () {
  const UI = window.AdminUI;
  const $ = (id) => document.getElementById(id);
  if (!UI || !window.Chart) { const n = $('chartNote'); if (n) n.textContent = 'Charts could not load.'; return; }
  const { esc, n, pct, secs, table, getJSON } = UI;
  const Chart = window.Chart;

  // Categorical slots in fixed order (validated palette, light surface). Colour follows the entity.
  const SLOT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
  const GRAY = '#9a9890';
  const SURFACE = '#fbfaf7';
  const ROLE = {
    sub: ['Sub / trade', SLOT[0]], gc: ['GC / builder', SLOT[1]], supplier: ['Supplier / rental', SLOT[2]],
    other: ['Something else', SLOT[3]], all: ['Everything', SLOT[4]], skipped: ['Skipped pop-up', SLOT[6]], none: ['No answer', GRAY],
  };
  const roleLabel = (r) => (ROLE[r] ? ROLE[r][0] : r);
  const roleColor = (r) => (ROLE[r] ? ROLE[r][1] : GRAY);
  const STAGE = {
    pre_approval: ['Pre-approval (planning case)', SLOT[0]], permit_pending: ['Permit, not yet issued', SLOT[1]],
    permit_issued: ['Permit, issued or later', SLOT[2]], permit_other: ['Permit, other or unknown stage', GRAY],
  };
  const REGION_ORDER = ['austin-tx', 'miami-dade-fl', 'miami-city-fl', 'raleigh-nc'];
  const regionColor = (r, all) => {
    const i = REGION_ORDER.indexOf(r);
    if (i >= 0) return SLOT[i];
    const extra = all.filter((x) => !REGION_ORDER.includes(x)).sort();
    return SLOT[REGION_ORDER.length + extra.indexOf(r)] || GRAY;
  };
  const regionLabel = (slug) => {
    const parts = String(slug).split('-');
    const st = parts.length > 1 && parts[parts.length - 1].length === 2 ? parts.pop().toUpperCase() : null;
    const name = parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return st ? `${name}, ${st}` : name;
  };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shortDay = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${MON[m - 1]} ${d}`; };

  Chart.defaults.font.family = '"Archivo", ui-sans-serif, system-ui, sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.color = '#55585f';
  Chart.defaults.borderColor = '#e2ded5';
  Chart.defaults.animation = false;
  Chart.defaults.plugins.legend.labels.boxWidth = 12;
  Chart.defaults.plugins.legend.labels.boxHeight = 12;
  Chart.defaults.plugins.tooltip.backgroundColor = '#1f2430';
  Chart.defaults.plugins.tooltip.padding = 8;

  const state = { days: 30, role: '', source: '', growthMode: 'overview', ingestMode: 'stage', ingestRegion: '' };
  try {
    const p = new URLSearchParams(location.search);
    if (['7', '30', '90'].includes(p.get('days'))) state.days = Number(p.get('days'));
    if (p.get('role')) state.role = p.get('role');
    if (p.get('source')) state.source = p.get('source');
  } catch { /* defaults */ }
  let data = null;
  const charts = {};

  /** Draw a chart, or say there is nothing to draw (a blank plot reads as zero). */
  function draw(id, config, emptyText) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    const canvas = $(id);
    const box = canvas.parentElement;
    let msg = box.querySelector('.empty');
    if (emptyText) {
      canvas.hidden = true;
      if (!msg) { msg = document.createElement('p'); msg.className = 'empty'; box.appendChild(msg); }
      msg.textContent = emptyText;
      box.classList.add('is-empty');
      return;
    }
    canvas.hidden = false;
    if (msg) msg.remove();
    box.classList.remove('is-empty');
    charts[id] = new Chart(canvas, config);
  }
  const intAxis = { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#ece8df' } };
  const xDays = { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } };

  function paintGrowth() {
    const d = data;
    const tracked = (day) => d.trackingSince && day >= d.trackingSince;
    const labels = d.growth.map((g) => shortDay(g.day));
    const val = (g, k) => (tracked(g.day) ? g[k] : null);
    let datasets;
    if (state.growthMode === 'role') {
      const roles = [...new Set(d.dauByRole.map((r) => r.role))];
      datasets = roles.map((role) => ({
        label: roleLabel(role), borderColor: roleColor(role), backgroundColor: roleColor(role),
        data: d.growth.map((g) => (tracked(g.day) ? (d.dauByRole.find((r) => r.day === g.day && r.role === role) || { dau: 0 }).dau : null)),
      }));
    } else {
      datasets = [
        ['Active', 'dau', SLOT[0]], ['New', 'new_actors', SLOT[1]], ['Returning', 'returning', SLOT[2]], ['Email sign-ups', 'signups', SLOT[3]],
      ].map(([label, k, c]) => ({ label, borderColor: c, backgroundColor: c, data: d.growth.map((g) => val(g, k)) }));
    }
    for (const ds of datasets) Object.assign(ds, { borderWidth: 2, pointRadius: d.growth.length > 31 ? 0 : 3, pointHoverRadius: 5, tension: 0, spanGaps: false });
    draw('cGrowth', {
      type: 'line', data: { labels, datasets },
      options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        scales: { x: xDays, y: intAxis }, plugins: { legend: { position: 'bottom' } } },
    });
    $('tGrowth').innerHTML = table([['day', 'Day'], ['dau', 'Active', 'n'], ['new_actors', 'New', 'n'], ['returning', 'Returning', 'n'], ['signups', 'Sign-ups', 'n']],
      d.growth.filter((g) => tracked(g.day)).slice().reverse());
  }

  function paintIngest() {
    const d = data;
    const regions = [...new Set(d.ingestion.map((r) => r.region))].sort();
    const sel = $('ingestRegion');
    sel.innerHTML = '<option value="">Every region</option>' + regions.map((r) => `<option value="${esc(r)}">${esc(regionLabel(r))}</option>`).join('');
    sel.value = regions.includes(state.ingestRegion) ? state.ingestRegion : '';
    sel.hidden = state.ingestMode === 'region';
    const rows = d.ingestion.filter((r) => state.ingestMode === 'region' || !sel.value || r.region === sel.value);
    const days = d.growth.map((g) => g.day);
    const keys = state.ingestMode === 'region' ? regions : Object.keys(STAGE).filter((k) => rows.some((r) => r.stage === k));
    const datasets = keys.map((k) => {
      const color = state.ingestMode === 'region' ? regionColor(k, regions) : STAGE[k][1];
      return {
        label: state.ingestMode === 'region' ? regionLabel(k) : STAGE[k][0], backgroundColor: color,
        borderColor: SURFACE, borderWidth: { top: 2 }, borderSkipped: false, borderRadius: 2,
        data: days.map((day) => rows.filter((r) => r.day === day && (state.ingestMode === 'region' ? r.region === k : r.stage === k)).reduce((a, r) => a + r.n, 0)),
      };
    });
    draw('cIngest', {
      type: 'bar', data: { labels: days.map(shortDay), datasets },
      options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        scales: { x: { ...xDays, stacked: true }, y: { ...intAxis, stacked: true } },
        plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { footer: (items) => `Total: ${n(items.reduce((a, i) => a + i.parsed.y, 0))}` } } } },
    }, rows.length ? null : 'No records added in this window.');
    const byDay = days.map((day) => {
      const r = { day };
      let total = 0;
      for (const ds of datasets) { const v = ds.data[days.indexOf(day)]; r[ds.label] = v; total += v; }
      r.total = total;
      return r;
    }).reverse();
    $('tIngest').innerHTML = table([['day', 'Day'], ...datasets.map((ds) => [ds.label, ds.label, 'n']), ['total', 'Total', 'n']], byDay);
    if (!d.ingestion.length) $('tIngest').innerHTML = '<p class="empty">No records added in this window.</p>';
  }

  function paintFunnel() {
    const f = data.funnel || {};
    const steps = [
      ['Landed', f.landed, f.landed], ['Answered the pop-up', f.answered, f.answered], ['Searched', f.searched, f.any_searched],
      ['Opened a record', f.opened, f.any_opened], ['Called / copied / saved', f.intent, f.any_intent], ['Came back on a later day', f.returned, f.any_returned],
    ];
    draw('cFunnel', {
      type: 'bar',
      data: { labels: steps.map((s) => s[0]), datasets: [{ label: 'People', data: steps.map((s) => s[1] || 0), backgroundColor: SLOT[0], borderRadius: 4, borderSkipped: 'start', barPercentage: 0.7 }] },
      options: { indexAxis: 'y', maintainAspectRatio: false, scales: { x: intAxis, y: { grid: { display: false } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${n(c.parsed.x)} people · ${pct(c.parsed.x, f.landed)} of landed`, afterLabel: (c) => `${n(steps[c.dataIndex][2])} did this step at all` } } } },
    }, f.landed ? null : 'Nobody was first seen in this window.');
    $('tFunnel').innerHTML = f.landed
      ? table([['step', 'Step'], ['strict', 'In order', 'n'], ['share', '% of landed', 'n'], ['any', 'Did it at all', 'n']],
        steps.map(([step, strict, any]) => ({ step, strict, any, share: pct(strict, f.landed) })))
      : '<p class="empty">Nobody was first seen in this window.</p>';
  }

  function paintSources() {
    const rows = data.sources;
    draw('cSources', {
      type: 'bar',
      data: { labels: rows.map((r) => r.source),
        datasets: [
          { label: 'People', data: rows.map((r) => r.actors), backgroundColor: SLOT[0], borderRadius: 4, borderSkipped: 'start' },
          { label: 'Activated', data: rows.map((r) => r.activated), backgroundColor: SLOT[1], borderRadius: 4, borderSkipped: 'start' },
        ] },
      options: { indexAxis: 'y', maintainAspectRatio: false, scales: { x: intAxis, y: { grid: { display: false } } }, plugins: { legend: { position: 'bottom' } } },
    }, rows.length ? null : 'No visits in this window.');
    $('tSources').innerHTML = table([['source', 'Source'], ['sessions', 'Visits', 'n'], ['actors', 'People', 'n'], ['activated', 'Activated', 'n'], ['rate', 'Activation', 'n', (_v, r) => pct(r.activated, r.actors)]], rows);
  }

  function paintRoles() {
    const rows = data.roles;
    const labels = rows.map((r) => roleLabel(r.role));
    const colors = rows.map((r) => roleColor(r.role));
    const bar = (id, values, fmt, max, empty) => draw(id, {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 4, borderSkipped: 'start', barPercentage: 0.7 }] },
      options: { indexAxis: 'y', maintainAspectRatio: false,
        scales: { x: { beginAtZero: true, max, grid: { color: '#ece8df' }, ticks: { maxRotation: 0, maxTicksLimit: 4, callback: (v) => fmt(v) } }, y: { grid: { display: false } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.raw == null ? 'not enough data' : fmt(c.raw)} · ${n(rows[c.dataIndex].actors)} people${id === 'cRoleRet' ? ` · ${n(rows[c.dataIndex].d7Returned)}/${n(rows[c.dataIndex].d7Eligible)} came back` : ''}` } } } },
    }, empty);
    const none = rows.length ? null : 'No visits in this window.';
    bar('cRoleTime', rows.map((r) => r.avgSessionSeconds), (v) => secs(Math.round(v)), undefined, none);
    bar('cRoleSearch', rows.map((r) => r.searchesPerActor), (v) => String(Math.round(v * 10) / 10), undefined, none);
    bar('cRoleRet', rows.map((r) => (r.d7Rate == null ? null : r.d7Rate * 100)), (v) => `${Math.round(v)}%`, 100,
      none || (rows.some((r) => r.d7Eligible) ? null : 'Nobody first seen in this window is 7 days in yet.'));
    $('tRoles').innerHTML = table([
      ['role', 'Role', '', (v) => esc(roleLabel(v))], ['actors', 'People', 'n'], ['avgSessionSeconds', 'Avg active / visit', 'n', secs],
      ['searchesPerActor', 'Searches / person', 'n', (v) => (v == null ? '—' : esc(v))],
      ['d7Rate', 'Day-7 retention', 'n', (_v, r) => (r.d7Eligible ? `${pct(r.d7Returned, r.d7Eligible)} (${r.d7Returned}/${r.d7Eligible})` : '—')]], rows);
  }

  function paintFilters() {
    for (const b of document.querySelectorAll('[data-days]')) b.setAttribute('aria-pressed', String(Number(b.dataset.days) === state.days));
    const roleSel = $('chartRole');
    roleSel.innerHTML = '<option value="">Every role</option>' + Object.keys(ROLE).map((r) => `<option value="${esc(r)}">${esc(roleLabel(r))}</option>`).join('');
    roleSel.value = state.role;
    const srcSel = $('chartSource');
    const opts = (data && data.sourceOptions) || [];
    if (state.source && !opts.some((o) => o.source === state.source)) opts.push({ source: state.source, actors: 0 });
    srcSel.innerHTML = '<option value="">Every source</option>' + opts.map((o) => `<option value="${esc(o.source)}">${esc(o.source)}</option>`).join('');
    srcSel.value = state.source;
    $('growthMode').value = state.growthMode;
    $('ingestMode').value = state.ingestMode;
  }

  async function load() {
    paintFilters();
    $('chartNote').textContent = 'Loading charts…';
    const qs = new URLSearchParams({ days: String(state.days), ...(state.role ? { role: state.role } : {}), ...(state.source ? { source: state.source } : {}) });
    try {
      data = await getJSON(`/api/admin/analytics/charts?${qs}`);
      paintFilters();
      paintGrowth(); paintIngest(); paintFunnel(); paintSources(); paintRoles();
      const filt = [state.role && `role: ${roleLabel(state.role)}`, state.source && `source: ${state.source}`].filter(Boolean).join(', ');
      $('chartNote').textContent = `Last ${state.days} days, UTC${filt ? `, ${filt}` : ''}. `
        + (data.trackingSince ? `Visitor tracking started ${shortDay(data.trackingSince)}; earlier days are blank, not zero.` : 'No visits recorded yet.')
        + ' Pop-up answers are recorded from Nov 16.';
    } catch (err) { $('chartNote').innerHTML = `<span class="err">Couldn't load the charts: ${esc(err.message)}</span>`; }
  }

  $('chartDays').addEventListener('click', (e) => { const b = e.target.closest('[data-days]'); if (b) { state.days = Number(b.dataset.days); load(); } });
  $('chartRole').addEventListener('change', (e) => { state.role = e.target.value; load(); });
  $('chartSource').addEventListener('change', (e) => { state.source = e.target.value; load(); });
  $('growthMode').addEventListener('change', (e) => { state.growthMode = e.target.value; if (data) paintGrowth(); });
  $('ingestMode').addEventListener('change', (e) => { state.ingestMode = e.target.value; if (data) paintIngest(); });
  $('ingestRegion').addEventListener('change', (e) => { state.ingestRegion = e.target.value; if (data) paintIngest(); });
  UI.ready.then(load);
}());
