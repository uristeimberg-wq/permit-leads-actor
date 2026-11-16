// Pilot overview: the first screen. Everything drawn here comes from
// /api/pilot/overview, which counts stored permits; nothing is estimated.
// Third-party text goes through esc() before innerHTML (CLAUDE.md rule 8).
(function () {
  const L = window.Live;
  const p = L.params();
  const source = L.areaOf(p.source);
  const area = L.AREA[source];
  let city = area.replace(/, [A-Z]{2}$/, '');
  const n = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
  const $ = (id) => document.getElementById(id);
  const share = (a, b) => (b ? Math.round((a / b) * 100) : null);

  $('top').innerHTML = L.topBar('index.html');
  $('area').innerHTML = Object.entries(L.AREA).map(([k, label]) =>
    `<a href="?${L.qs({ source: k })}"${k === source ? ' aria-current="true"' : ''}>${L.esc(label)}</a>`).join('');
  $('ov-title').textContent = `${city} permit activity`;
  if ($('cta-gcs')) $('cta-gcs').href = `gcs.html?${L.qs({ source })}`;
  if ($('cta-leads')) $('cta-leads').href = `digest.html?${L.qs({ source })}`;

  L.api(`/api/pilot/overview?${L.qs({ source })}`).then(render).catch((err) => {
    $('hero-line').textContent = '';
    L.fail($('gcs'), err);
    for (const id of ['recent', 'figs', 'weekly', 'mapcard', 'fresh']) $(id).innerHTML = '';
  });

  function render(d) {
    const t = d.totals;
    if (d.meta && d.meta.city) city = d.meta.city;
    drawHero(d, t);
    drawFresh(d, t);
    drawFigures(d, t);
    drawWeekly(d.weekly);
    drawMap(d.map);
    drawGcs(d.topGcs, t);
    drawRecent(d.recent);
    if (d.jobLinksHidden) $('recent').insertAdjacentHTML('beforeend', `<p class="note">${L.esc(d.jobLinksHidden)}</p>`);
    $('foot').innerHTML = L.attribution(d.meta)
      + `<p class="note">Counts are permits we hold for ${L.esc(area)}, by the source's issue date. A building permit and its trade permits are linked by
        ${L.esc((d.meta && d.meta.jobLink) || 'permit number')}. Company lists leave out contractors whose name looks like a person's (ADR-10).
        Map pins sit at each ZIP's centre, not at the job's address.</p>`;
  }

  function drawHero(d, t) {
    $('hero-fig').innerHTML = `<b>${n(t.buildingRecent)}</b><span>building permits issued in ${L.esc(city)} in the last ${t.recentDays} days</span>`;
    if (!t.buildingRecent) {
      $('hero-line').textContent = `No building permits in the last ${t.recentDays} days of our data.`;
      return;
    }
    const prior = t.buildingPrior ? ` That compares with ${n(t.buildingPrior)} in the ${t.recentDays} days before.` : '';
    $('hero-line').innerHTML = `<strong>${n(t.buildingRecentWithBusinessGc)}</strong> of them name a business as the general contractor, and
      <strong>${n(t.buildingRecentWithPhone)}</strong> of those carry a phone from the permit record that we can show.${prior}`;
  }

  function drawFresh(d, t) {
    const m = d.meta || {};
    const stale = !m.lastSyncAt || Date.now() - new Date(m.lastSyncAt) > 36 * 3600000;
    const endpoint = window.safeHttpUrl ? window.safeHttpUrl(m.endpoint) : null;
    $('fresh').innerHTML = `<h2>Data freshness</h2>
      <dl class="ov-dl">
        <dt>Last sync</dt><dd class="${stale ? 'err' : ''}">${L.esc(L.dateTime(m.lastSyncAt))}${m.lastSyncStatus === 'failed' ? '; the latest attempt failed' : ''}${stale ? '; stale' : ''}</dd>
        <dt>Publication lag</dt><dd>${L.esc(m.publicationLag || 'not measured')}${source === 'austin-tx' ? ', so the last few days are still filling in' : ''}</dd>
        <dt>Issue dates held</dt><dd>From about ${L.esc(L.date(m.historyFrom))} to ${L.esc(L.date(m.historyTo || t.lastIssuedOn))}</dd>
        <dt>Permits held</dt><dd class="mono">${n(t.permits)}</dd>
        <dt>Source</dt><dd>${endpoint ? `<a href="${L.esc(endpoint)}" rel="noopener noreferrer" target="_blank">${L.esc(m.attribution || m.source)}</a>` : L.esc(m.attribution || 'unknown')}</dd>
      </dl>`;
  }

  function drawFigures(d, t) {
    const r = d.repeatHiring || {};
    const e = r.electrical || {};
    const others = ['plumbing', 'mechanical'].filter((k) => r[k] && r[k].rate != null)
      .map((k) => `${k} ${L.pct(r[k].rate)}`).join(', ');
    const valuedShare = share(t.buildingRecentValued, t.buildingRecent);
    $('figs').innerHTML = `
      <div><b>${n(t.activeGcs)}</b><span>general contractors filed a building permit in the last ${t.activeDays} days</span><em>Businesses only</em></div>
      <div><b>${n(t.activeSubs)}</b><span>trade subs pulled an electrical, plumbing or mechanical permit in ${t.activeDays} days</span><em>Businesses only</em></div>
      <div><b>${e.rate == null ? '—' : L.pct(e.rate)}</b><span>of electricians hired by a GC with an earlier job were ones that GC had used before</span>
        <em>${d.jobLinksHidden ? 'Not shown: job links not hand-checked yet' : e.rate == null ? 'Not enough linked jobs yet' : `${n(e.repeatHires)} of ${n(e.eligibleHires)} hires over 12 months${others ? `; ${L.esc(others)}` : ''}`}</em></div>
      <div><b>${t.buildingRecentMedianValue == null ? '—' : L.esc(L.money(t.buildingRecentMedianValue))}</b><span>median declared value of the last ${t.recentDays} days' building permits</span>
        <em>${t.buildingRecentValued ? `${n(t.buildingRecentValued)} of ${n(t.buildingRecent)} publish a value (${valuedShare}%)` : 'None publish a value'}</em></div>`;
  }

  // Stacked weekly bars: building permits (the argued series), trade permits, the rest.
  function drawWeekly(weeks) {
    const el = $('weekly');
    const held = weeks.filter((w) => w.permits != null);
    if (!held.length) { el.insertAdjacentHTML('beforeend', '<p class="state">No permits in the last 26 weeks of our data.</p>'); el.querySelector('.skel')?.remove(); return; }
    const W = 760, H = 260, padL = 40, padB = 26, padT = 12;
    const max = Math.max(...held.map((w) => w.permits));
    const step = niceStep(max / 4);
    const top = Math.ceil(max / step) * step || 1;
    const bw = (W - padL) / weeks.length;
    const y = (v) => H - padB - ((H - padB - padT) * v) / top;
    let grid = '';
    for (let v = 0; v <= top; v += step) grid += `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${n(v)}</text>`;
    let bars = '';
    let labels = '';
    let lastMonth = null;
    weeks.forEach((w, i) => {
      const x = padL + i * bw + 2;
      const width = Math.max(2, bw - 4);
      const month = new Date(`${w.weekOf}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
      if (month !== lastMonth) { labels += `<text x="${x}" y="${H - 8}">${month}</text>`; lastMonth = month; }
      if (w.permits == null) return;
      const other = Math.max(0, w.permits - w.building - w.trade);
      const yb = y(w.building), yt = y(w.building + w.trade), yo = y(w.permits);
      const tip = `Week of ${L.date(w.weekOf)}${w.partial ? ' (this week, still filling in)' : ''}: ${n(w.building)} building, ${n(w.trade)} trade, ${n(other)} other permits`;
      bars += `<g class="${w.partial ? 'partial' : ''}"><title>${L.esc(tip)}</title>
        <rect class="bar-b" x="${x}" width="${width}" y="${yb}" height="${Math.max(0, y(0) - yb)}"/>
        <rect class="bar-t" x="${x}" width="${width}" y="${yt}" height="${Math.max(0, yb - yt)}"/>
        <rect class="bar-x" x="${x}" width="${width}" y="${yo}" height="${Math.max(0, yt - yo)}"/></g>`;
    });
    const last = weeks[weeks.length - 1];
    const firstHeld = weeks.find((w) => w.permits != null);
    const avg = Math.round(held.filter((w) => !w.partial).reduce((s, w) => s + w.building, 0) / Math.max(1, held.filter((w) => !w.partial).length));
    $('weekly-sub').textContent = `Average ${n(avg)} building permits a week over the full weeks shown`;
    el.innerHTML = el.querySelector('.sec-head').outerHTML + `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Permits issued per week, last 26 weeks">
        <g class="grid">${grid}</g><g>${bars}</g><g class="axis">${labels}</g>
        ${last.partial ? `<text x="${W}" y="${padT - 2}" text-anchor="end">This week is partial</text>` : ''}
      </svg>
      <div class="legend"><span><i class="b"></i>Building permits</span><span><i class="t"></i>Trade permits (electrical, plumbing, mechanical)</span><span><i class="x"></i>Other permits</span></div>
      ${firstHeld !== weeks[0] ? `<p class="note">No bars before ${L.esc(L.date(firstHeld.weekOf))}: our data starts there, so earlier weeks are missing, not zero.</p>` : ''}`;
    $('weekly-sub').textContent = `Average ${n(avg)} building permits a week over the full weeks shown`;
  }

  function niceStep(raw) {
    if (raw <= 0) return 1;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  }

  function drawMap(m) {
    const top = m.pins.slice(0, 8);
    $('map-sub').textContent = `Last ${m.days} days, by ZIP${m.unplaced ? `; ${n(m.unplaced)} permits we could not place` : ''}`;
    $('zips').innerHTML = top.map((pin) => `<li><span class="mono">${L.esc(pin.label)}</span>
      <span><b class="mono">${n(pin.building)}</b> building, <span class="mono">${n(pin.permits)}</span> all</span>
      ${pin.zip ? `<a href="gcs.html?${L.qs({ source, zips: pin.zip })}">GCs here</a>` : ''}</li>`).join('')
      || '<li class="sub">No permits placed in this window.</li>';
    const el = $('map');
    if (!window.L || !m.pins.length) { el.classList.add('ov-map--off'); el.innerHTML = `<p class="state">${m.pins.length ? 'The map could not load; the busiest ZIPs are listed below.' : 'Nothing to map yet.'}</p>`; return; }
    // On touch screens one finger scrolls the page, not the map; pinch still
    // zooms and the zoom buttons still work, so the map never traps the page.
    const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const map = window.L.map(el, { scrollWheelZoom: false, zoomControl: true, attributionControl: true, dragging: !touch, tap: false });
    // Once zoomed in past the starting view, one finger pans the map.
    let startZoom = Infinity;
    if (touch) map.on('zoomend', () => { if (map.getZoom() > startZoom) map.dragging.enable(); else map.dragging.disable(); });
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 16, className: 'ov-tiles', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    const max = Math.max(...m.pins.map((pin) => pin.building || pin.permits));
    const bounds = [];
    for (const pin of m.pins) {
      const v = pin.building || 0;
      const radius = (touch ? 8 : 3) + 15 * Math.sqrt(v / (max || 1)); // a fingertip needs a bigger pin
      const links = pin.zip ? `<br><a href="gcs.html?${L.qs({ source, zips: pin.zip })}">GCs working here</a> &nbsp; <a href="digest.html?${L.qs({ source, zips: pin.zip, days: 30 })}">New permits here</a>` : '';
      window.L.circleMarker([pin.lat, pin.lng], { radius, className: v ? 'ov-pin' : 'ov-pin ov-pin--quiet', weight: 1.5 })
        .bindPopup(`<strong>${L.esc(pin.label)}</strong><br>${n(v)} building permits, ${n(pin.permits)} permits in all, last ${m.days} days${links}`)
        .bindTooltip(`${L.esc(pin.label)}: ${n(v)} building`, { direction: 'top' })
        .addTo(map);
      bounds.push([pin.lat, pin.lng]);
    }
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 12 });
    startZoom = map.getZoom();
  }

  function spark(weeks) {
    if (!weeks || !weeks.length) return '';
    const max = Math.max(1, ...weeks);
    const bw = 6, gap = 2, h = 22;
    return `<svg class="spark" width="${weeks.length * (bw + gap)}" height="${h}" viewBox="0 0 ${weeks.length * (bw + gap)} ${h}" role="img" aria-label="Building permits per week, last 13 weeks: ${weeks.join(', ')}">
      ${weeks.map((v, i) => `<rect x="${i * (bw + gap)}" y="${h - Math.max(v ? 2 : 0, (h * v) / max)}" width="${bw}" height="${Math.max(v ? 2 : 0, (h * v) / max)}"/>`).join('')}</svg>`;
  }

  function drawGcs(rows, t) {
    const el = $('gcs');
    $('gcs-sub').textContent = `By building permits in the last ${t.activeDays} days`;
    const head = el.querySelector('.sec-head').outerHTML;
    if (!rows.length) { el.innerHTML = `${head}<p class="state">No business GCs filed building permits in this window.</p>`; return; }
    el.innerHTML = `${head}<table>
      <thead><tr><th class="n hide-sm">#</th><th>General contractor</th><th class="n">Building permits</th><th class="hide-sm">Last 13 weeks</th>
        <th class="n">Subs on those jobs</th><th class="hide-sm">Latest permit</th><th>Phone</th></tr></thead>
      <tbody>${rows.map((g, i) => `<tr>
        <td class="n hide-sm sub">${i + 1}</td>
        <td>${L.who(g.gc)}<div class="sub">${g.zips} ZIP${g.zips === 1 ? '' : 's'}${g.topZip ? `, most in ${L.esc(g.topZip)}` : ''}</div></td>
        <td class="n">${n(g.jobs)}</td>
        <td class="hide-sm">${spark(g.weeks)}</td>
        <td class="n">${g.subsHired == null ? '<span class="sub">not shown</span>' : `${n(g.subsHired)}<div class="sub">on ${n(g.linkedJobs)} linked job${g.linkedJobs === 1 ? '' : 's'}</div>`}</td>
        <td class="mono hide-sm">${L.esc(L.date(g.lastJobOn))}</td>
        <td>${L.phoneCell(g.gc.phone)}</td></tr>`).join('')}</tbody></table>
      <p class="note"><a href="gcs.html?${L.qs({ source })}">Every GC, with how each one hires electricians, plumbers and HVAC contractors</a></p>`;
  }

  function drawRecent(rows) {
    const el = $('recent');
    const head = el.querySelector('.sec-head').outerHTML;
    $('recent-sub').textContent = 'Newest issue date first, with the trade permits on each job so far';
    if (!rows.length) { el.innerHTML = `${head}<p class="state">No building permits in our data yet.</p>`; return; }
    const tradeCell = (r) => (r.trades == null ? '<span class="sub">not shown</span>' : r.trades.length
      ? r.trades.map((k) => `<span class="pill ok">${L.esc(L.TRADE[k] || k)}</span>`).join('')
      : '<span class="pill warn">No trade permit on record</span>');
    el.innerHTML = `${head}<table>
      <thead><tr><th>Issued</th><th>Permit</th><th class="hide-sm">Address</th><th class="n hide-sm">Declared value</th><th>General contractor</th><th>Trade permits on the job</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="mono">${L.esc(L.date(r.issuedOn))}</td>
        <td class="mono"><a href="job.html?${L.qs({ id: r.id, trade: 'electrical' })}">${L.esc(r.permitNumber)}</a></td>
        <td class="hide-sm">${L.esc(r.address || 'Address not published')}</td>
        <td class="n hide-sm">${L.esc(window.Values.valueText(r.valuation, r.valuationRepeats))}</td>
        <td>${L.who(r.gc)}</td>
        <td>${tradeCell(r)}</td></tr>`).join('')}</tbody></table>
      <p class="note">"No trade permit on record" means the source has published no issued trade permit on this job. It says nothing about whether a sub is hired: one may be in review, or lined up already.
        <a href="digest.html?${L.qs({ source })}">Open this week's new permits</a></p>`;
  }
}());
