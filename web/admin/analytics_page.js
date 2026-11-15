// The owner's analytics dashboard (web/admin/analytics.html). Reads only
// /api/admin/analytics/*; renders real numbers or says there are none.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
  const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—');
  const secs = (s) => (s == null ? '—' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
  // Short UTC dates, "Nov 15 18:54", with the year only when it is not this one.
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const when = (t) => {
    if (!t) return '—';
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return '—';
    const yr = d.getUTCFullYear() === new Date().getUTCFullYear() ? '' : ` ${d.getUTCFullYear()}`;
    return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}${yr} ${d.toISOString().slice(11, 16)}`;
  };
  const clock = (t) => (t ? new Date(t).toISOString().slice(11, 16) : '');
  const EMPTY = '<p class="empty">No data in this range yet.</p>';

  // This browser is the owner's: its own tracked visits are marked internal,
  // and so are its earlier ones, and any email account signed in on it.
  let deviceId = null;
  try { localStorage.setItem('ct_internal', '1'); deviceId = localStorage.getItem('ct_device'); } catch { /* private mode */ }
  const marked = fetch('/api/admin/analytics/internal', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_id: /^[0-9a-f-]{36}$/i.test(deviceId || '') ? deviceId : null }),
  }).then((r) => r.text()).catch(() => null);   // read the body, or the request never finishes

  const state = { range: '7d', user: '' };
  try { const p = new URLSearchParams(location.search); if (p.get('range')) state.range = p.get('range'); if (p.get('user')) state.user = p.get('user'); } catch { /* defaults */ }

  const table = (cols, rows) => (rows && rows.length ? `<div class="tw"><table><thead><tr>${cols.map(([, h, c]) => `<th class="${c || ''}">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map(([k, h, c, f]) => `<td class="${c || ''}" data-label="${esc(h)}">${f ? f(r[k], r) : esc(r[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : EMPTY);

  async function getJSON(url) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`; throw new Error('Owner sign-in needed'); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  const qs = () => new URLSearchParams({ range: state.range, ...(state.user ? { user: state.user } : {}) }).toString();

  function paint(d) {
    const a = d.activity; const t = d.totals;
    // [label, value, what it means]. Fixed windows (DAU/WAU/MAU, stickiness) ignore the range picker.
    const kpis = [
      ['DAU · daily active', n(a.dau), 'People who used the app today (UTC).'],
      ['WAU · weekly active', n(a.wau), 'People who used it in the last 7 days.'],
      ['MAU · monthly active', n(a.mau), 'People who used it in the last 30 days.'],
      ['Stickiness', a.stickiness == null ? '—' : `${Math.round(a.stickiness * 100)}%`,
        `Average daily users ÷ MAU, over ${a.daysTracked || 0} day${a.daysTracked === 1 ? '' : 's'} of data: how often monthly users come back. 100% = every day.`],
      ['Sessions', n(t.sessions), 'Visits in the range. A new visit starts after 30 minutes idle.'],
      ['People / devices', n(t.actors), 'Distinct people in the range: a signed-in user, else one browser.'],
      ['Avg active time / visit', secs(t.avg_active_seconds), 'Time the tab was on screen, per visit. Background tabs don’t count.'],
      ['Searches', n(t.searches), 'Searches with new filters in the range (paging not counted).'],
      ['Anonymous → registered', d.conversion.rate == null ? '—' : `${pct(d.conversion.registered, d.conversion.devices)} (${n(d.conversion.registered)}/${n(d.conversion.devices)})`,
        'Browsers first seen in the range that later signed in with an email.'],
    ];
    $('kpis').innerHTML = kpis.map(([l, v, h]) => `<div class="card kpi"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div><div class="h">${esc(h)}</div></div>`).join('');
    $('status').textContent = `${n(t.events)} events in range. Last event received: ${when(t.last_event_at)}. Excluded: ${n(d.excluded.internal)} internal and ${n(d.excluded.bots)} automated sessions. DAU/WAU/MAU are fixed windows ending now.`;

    $('retention').innerHTML = d.retention.some((r) => r.eligible)
      ? table([['day', 'Came back after', '', (v) => `${esc(v)}+ day${v > 1 ? 's' : ''}`], ['returned', 'Returned', 'n'], ['eligible', 'Cohort', 'n'], ['rate', 'Rate', 'n', (_v, r) => pct(r.returned, r.eligible)]], d.retention)
      : '<p class="empty">No cohort old enough yet. A cohort counts once its first visit is N days old.</p>';

    const f = d.funnel || {};
    const steps = [['Landed', f.landed], ['Searched', f.searched], ['Opened a record', f.opened], ['Contact / save / export', f.intent], ['Came back later', f.returned]];
    $('funnel').innerHTML = f.landed ? steps.map(([l, v]) => `<div class="bar"><span>${esc(l)}</span><span class="track"><span class="fill" style="display:block;width:${f.landed ? Math.round((v / f.landed) * 100) : 0}%"></span></span><span>${n(v)} · ${pct(v, f.landed)}</span></div>`).join('') : EMPTY;

    $('terms').innerHTML = table([['term', 'Term'], ['searches', 'Searches', 'n'], ['actors', 'People', 'n'], ['zero', 'Zero results', 'n']], d.search.terms);
    $('zero').innerHTML = table([['query', 'Query', '', (v) => esc(v || '(no keyword)')], ['filters', 'Filters', '', (v) => esc(v ? Object.entries(v).map(([k, x]) => `${k}=${x}`).join(', ') : '')], ['times', 'Times', 'n'], ['last_at', 'Last', '', when]], d.search.zero);
    $('areas').innerHTML = table([['area', 'Area'], ['searches', 'Searches', 'n']], d.search.areas);
    $('stages').innerHTML = table([['stage', 'Stage'], ['searches', 'Searches', 'n']], d.search.stages);
    $('filters').innerHTML = table([['filter', 'Filter'], ['applied', 'Applied', 'n'], ['cleared', 'Cleared', 'n']], d.search.filters);
    $('records').innerHTML = table([['type', 'Type'], ['id', 'Record', '', (v, r) => esc(r.label ? `${r.label} (#${v})` : v)], ['clicks', 'Clicks', 'n'], ['views', 'Views', 'n'], ['read_ms', 'Reading time', 'n', (v) => secs(Math.round(Number(v) / 1000))], ['actors', 'People', 'n']], d.records);
    $('paths').innerHTML = table([['from_path', 'From'], ['to_path', 'To'], ['times', 'Times', 'n']], d.paths);
    $('elements').innerHTML = table([['event_name', 'Event'], ['element_id', 'Element'], ['element_label', 'Label'], ['clicks', 'Clicks', 'n']], d.elements);
    $('errors').innerHTML = table([['event_name', 'Kind'], ['detail', 'Detail'], ['times', 'Times', 'n'], ['last_at', 'Last', '', when]], d.errors);
  }

  async function loadUsers() {
    const { users } = await getJSON('/api/admin/analytics/users');
    $('user').innerHTML = '<option value="">All users</option>' + users.map((u) => `<option value="${esc(u.id)}">${esc(u.email)}</option>`).join('');
    $('user').value = state.user;
    $('users').innerHTML = table([
      ['email', 'User', '', (v, r) => `<button type="button" class="userlink" data-user="${esc(r.id)}">${esc(v)}</button>`],
      ['sessions', 'Sessions', 'n'], ['active_seconds', 'Active time', 'n', secs], ['searches', 'Searches', 'n'], ['saved', 'Saved', 'n'],
      ['last_active_at', 'Last active', '', when], ['created_at', 'Signed up', '', when]], users);
  }

  const describe = (e) => {
    const p = e.properties || {};
    switch (e.event_name) {
      case 'search_executed': return `searched “${p.query || ''}” (${p.view || ''}) → ${p.results_count ?? '?'} results${p.zero_results ? ' · ZERO' : ''}`;
      case 'page_exit': return `left ${e.page_path} after ${secs(Math.round((p.dwell_time_ms || 0) / 1000))} active`;
      case 'record_detail_viewed': return `read ${e.target_entity_type} ${e.target_record_id} for ${secs(Math.round((p.read_time_ms || 0) / 1000))}`;
      case 'filter_applied': case 'filter_cleared': return `${e.event_name.replace('_', ' ')} ${p.filter || ''}${p.value != null ? ` = ${p.value}` : ''}`;
      default: return `${e.event_name}${e.target_record_id ? ` ${e.target_entity_type || ''} ${e.target_record_id}` : ''}${e.element_label ? ` “${e.element_label}”` : ''} on ${e.page_path || ''}`;
    }
  };
  async function openTimeline(id) {
    $('timelineCard').hidden = false;
    $('timeline').innerHTML = '<p class="empty">Loading…</p>';
    try {
      const t = await getJSON(`/api/admin/analytics/users/${encodeURIComponent(id)}/timeline`);
      $('timelineTitle').textContent = `Timeline: ${t.user.email}`;
      $('timeline').innerHTML = (t.sessions.length ? t.sessions.map((s) => `<div class="sess">
        <strong>${esc(when(s.started_at))}</strong> · ${esc(secs(s.duration_seconds))} active · ${esc([s.device_type, s.browser, s.os].filter(Boolean).join(' / '))}
        ${s.referrer ? ` · from ${esc(s.referrer)}` : ''}${s.utm_source ? ` · utm ${esc(s.utm_source)}` : ''}${s.is_internal ? ' · internal' : ''}${s.is_bot ? ' · bot' : ''}
        <ol>${s.events.map((e) => `<li><time>${esc(clock(e.client_timestamp))}</time> ${esc(describe(e))}</li>`).join('')}</ol></div>`).join('')
        : EMPTY) + (t.truncated ? '<p class="note">Showing the newest 2,000 events.</p>' : '');
      $('timelineCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) { $('timeline').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  }

  async function load() {
    for (const b of document.querySelectorAll('[data-range]')) b.setAttribute('aria-pressed', String(b.dataset.range === state.range));
    for (const [id, kind] of [['csvEvents', 'events'], ['csvSessions', 'sessions'], ['csvSearches', 'searches']]) $(id).href = `/api/admin/analytics/export.csv?kind=${kind}&${qs()}`;
    history.replaceState(null, '', `?${qs()}`);
    $('status').textContent = 'Loading…';
    try { paint(await getJSON(`/api/admin/analytics/summary?${qs()}`)); } catch (err) { $('status').innerHTML = `<span class="err">Couldn't load: ${esc(err.message)}</span>`; }
  }

  $('range').addEventListener('click', (e) => { const b = e.target.closest('[data-range]'); if (b) { state.range = b.dataset.range; load(); } });
  $('user').addEventListener('change', (e) => { state.user = e.target.value; load(); if (state.user) openTimeline(state.user); else $('timelineCard').hidden = true; });
  $('users').addEventListener('click', (e) => { const b = e.target.closest('[data-user]'); if (b) openTimeline(b.dataset.user); });
  marked.then(() => {
    loadUsers().catch((err) => { $('users').innerHTML = `<p class="err">${esc(err.message)}</p>`; });
    load();
  });
  if (state.user) openTimeline(state.user);
}());
