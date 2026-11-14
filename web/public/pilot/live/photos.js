/* Street-level photos of a job site, loaded live in the viewer's
 * browser (docs/IMAGERY.md, ADR-24). Nothing here is fetched, stored or
 * cached by our server: Google's terms forbid storing Street View images.
 *
 * Each photo is checked before it is shown, and labelled with its source,
 * capture date, distance from the job-site point and how sure we are it
 * shows the right building. A photo that fails the checks is not shown, so
 * a neighbouring building never stands in unlabelled.
 *
 * The pure functions (distance, bearing, the checks and labels) are also
 * required by photos.test.js in Node.
 */
(function (root) {
  const EARTH_M = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;

  /** Great-circle distance in metres between {lat, lng} points. */
  function distanceM(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** Initial compass bearing, 0-360 degrees, from `from` toward `to`. */
  function bearingDeg(from, to) {
    const y = Math.sin(rad(to.lng - from.lng)) * Math.cos(rad(to.lat));
    const x = Math.cos(rad(from.lat)) * Math.sin(rad(to.lat))
      - Math.sin(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.cos(rad(to.lng - from.lng));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  // Distance limits (docs/IMAGERY.md): within 40 m is usable, 40-60 m only as
  // "low", beyond 60 m nothing is shown.
  const MAX_M = 60;
  const GOOD_M = 40;
  const CLOSE_M = 25;
  const OLD_MONTHS = 36;

  /**
   * A capture date as published: Google gives "YYYY-MM" or "YYYY", other
   * sources a millisecond timestamp. Returns { label, y, m } or null when unknown.
   * Only the precision the source gives is kept (rule 7).
   */
  function captureDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v)) {
      const d = new Date(v);
      const y = d.getUTCFullYear(); const m = d.getUTCMonth() + 1;
      return { label: `${y}-${String(m).padStart(2, '0')}`, y, m };
    }
    const s = /^(\d{4})(?:-(\d{2}))?/.exec(String(v));
    if (!s) return null;
    const y = Number(s[1]); const m = s[2] ? Number(s[2]) : null;
    return { label: m ? `${y}-${s[2]}` : String(y), y, m };
  }

  /** Whole months from a capture to a date (the capture's last possible day, so never overstated). */
  function monthsSince(cap, isoDate) {
    if (!cap || !isoDate) return null;
    const d = new Date(String(isoDate).length === 10 ? `${isoDate}T12:00:00Z` : isoDate);
    if (Number.isNaN(d.getTime())) return null;
    return (d.getUTCFullYear() - cap.y) * 12 + (d.getUTCMonth() + 1) - (cap.m || 12);
  }

  /**
   * How sure we are that a photo shows the job site, and the caveats to print
   * beside it. `target` is the job's location as the job API returns it
   * ({ lat, lng, method, approximate }). `permitDate` is the permit's issue
   * date; `today` is for testing.
   *
   * Returns { ok: false, reason } when nothing should be shown, else
   * { ok: true, tier: 'high'|'medium'|'low', distanceM, notes: [] }.
   */
  function assess({ photoAt, target, captured, permitDate, today = new Date().toISOString() }) {
    if (!target || !Number.isFinite(Number(target.lat)) || !Number.isFinite(Number(target.lng))) {
      return { ok: false, reason: 'no job-site point to aim at' };
    }
    if (!photoAt || !Number.isFinite(Number(photoAt.lat)) || !Number.isFinite(Number(photoAt.lng))) {
      return { ok: false, reason: 'the source gave no camera position' };
    }
    const d = distanceM({ lat: Number(photoAt.lat), lng: Number(photoAt.lng) }, { lat: Number(target.lat), lng: Number(target.lng) });
    if (d > MAX_M) return { ok: false, reason: `the nearest image is about ${Math.round(d)} m from the job-site point` };

    const notes = [];
    // Start from distance, then lower for every doubt.
    let tier = d <= CLOSE_M ? 'high' : d <= GOOD_M ? 'medium' : 'low';
    const lower = (to) => { const order = ['high', 'medium', 'low']; if (order.indexOf(to) > order.indexOf(tier)) tier = to; };
    if (d > GOOD_M) notes.push('Taken some way from the job-site point; it may show a neighbouring building.');

    // A Census point is interpolated along the street's address range, so the
    // camera is aimed at an estimate of where the house is.
    if (target.method === 'census') {
      lower(target.approximate ? 'low' : 'medium');
      notes.push(target.approximate
        ? 'Aimed at an approximate point estimated from the address; it may show a neighbouring building.'
        : 'Aimed at a point estimated from the address along the street; the house may be a few doors off.');
    }

    if (!captured) {
      lower('medium');
      notes.push('Capture date not published by the source.');
    } else {
      const age = monthsSince(captured, today);
      if (age != null && age > OLD_MONTHS) { lower('medium'); notes.push(`Older image (${captured.label}).`); }
      const before = monthsSince(captured, permitDate);
      if (before != null && before > 0) notes.push(`Taken before this permit was issued, so it may show the site before the work (an empty lot or an earlier building).`);
    }
    return { ok: true, tier, distanceM: Math.round(d), notes };
  }

  // ── Google Street View Static ──────────────────────────────
  const SV = 'https://maps.googleapis.com/maps/api/streetview';

  /** The free metadata request (no image quota): outdoor panoramas within 60 m. */
  function streetViewMetaUrl(key, target) {
    const q = new URLSearchParams({ location: `${Number(target.lat)},${Number(target.lng)}`, radius: String(MAX_M), source: 'outdoor', key });
    return `${SV}/metadata?${q}`;
  }

  /** The billed image request: the panorama the metadata found, turned toward the job site. */
  function streetViewImageUrl(key, meta, target, d) {
    const heading = bearingDeg(meta.location, { lat: Number(target.lat), lng: Number(target.lng) });
    const q = new URLSearchParams({
      size: '640x400', pano: meta.pano_id, heading: heading.toFixed(1), fov: d < 15 ? '90' : '65', pitch: '5',
      return_error_code: 'true', key,
    });
    return `${SV}?${q}`;
  }

  /** Decide on a Street View metadata answer. */
  function streetViewPlan(meta, target, permitDate, today) {
    if (!meta || meta.status !== 'OK' || !meta.pano_id) {
      const why = meta && meta.status === 'ZERO_RESULTS' ? 'no outdoor Street View image within 60 m'
        : `Street View answered ${meta ? meta.status || 'nothing' : 'nothing'}`;
      return { ok: false, reason: why };
    }
    const captured = captureDate(meta.date);
    return { ...assess({ photoAt: meta.location, target, captured, permitDate, today }), captured, copyright: meta.copyright || null };
  }

  const TIER_TEXT = {
    high: 'likely the job site',
    medium: 'probably the job site',
    low: 'may not be the job site',
  };

  const pure = { distanceM, bearingDeg, captureDate, monthsSince, assess, streetViewPlan, streetViewMetaUrl,
    streetViewImageUrl, TIER_TEXT, MAX_M, GOOD_M };
  if (typeof module === 'object' && module.exports) { module.exports = pure; return; }

  // ── Browser: the "Photos" card on the job page ────────────
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const getJson = (url) => fetch(url, { referrerPolicy: 'strict-origin-when-cross-origin' }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });

  function figure({ src, alt, href, plan, credit, extra = '' }) {
    const label = `${TIER_TEXT[plan.tier]} · ${plan.captured ? `captured ${plan.captured.label}` : 'capture date unknown'} · about ${plan.distanceM} m from the job-site point`;
    return `<figure class="photo">
      <img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async" referrerpolicy="strict-origin-when-cross-origin" width="640" height="400">
      <figcaption>
        <span class="pill ${plan.tier === 'high' ? 'ok' : plan.tier === 'low' ? 'warn' : ''}">${esc(plan.tier)}</span> ${esc(label)}${extra}
        ${plan.notes.length ? `<br>${plan.notes.map(esc).join(' ')}` : ''}
        <br>${credit}${href ? ` · <a href="${esc(href)}" rel="noopener noreferrer" target="_blank">open at source</a>` : ''}
      </figcaption>
    </figure>`;
  }

  const none = (what, why) => `<p class="sub photo-none">${esc(what)}: no photo (${esc(why)}).</p>`;

  async function streetView(cfg, target, permitDate) {
    try {
      const meta = await getJson(streetViewMetaUrl(cfg.googleKey, target));
      const plan = streetViewPlan(meta, target, permitDate);
      if (!plan.ok) return { shown: false, html: none('Street View', plan.reason) };
      const src = streetViewImageUrl(cfg.googleKey, meta, target, plan.distanceM);
      const copy = plan.copyright ? esc(plan.copyright) : '© Google';
      return { shown: true, html: figure({
        src, alt: 'Google Street View toward the job site', plan,
        href: `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(meta.pano_id)}&heading=${bearingDeg(meta.location, target).toFixed(0)}`,
        credit: `<b>Google Maps</b> Street View, ${copy}`,
      }) };
    } catch (e) {
      return { shown: false, html: none('Street View', 'the request failed') };
    }
  }

  /**
   * Fill `el` with the photos card. `cfg` is /api/pilot/imagery
   * ({ googleKey }); `loc` the job's location. Without a key the card is
   * removed, so the page looks as it did before.
   */
  async function card(el, cfg, loc, permitDate) {
    if (!el) return;
    if (!cfg || !cfg.googleKey) { el.remove(); return; }
    if (!loc) { el.innerHTML = '<h2>Photos</h2><p class="sub">No photo: the job site has no map point to aim at.</p>'; return; }
    const target = { ...loc, lat: Number(loc.lat), lng: Number(loc.lng) };
    el.innerHTML = '<h2>Photos</h2><p class="sub">Loading…</p>';
    const sv = await streetView(cfg, target, permitDate);
    const google = sv.shown;
    el.innerHTML = `<h2>Photos</h2>
      <div class="photos">${sv.html}</div>
      ${google ? `<p class="note">Shown live from Google and never stored by us. "Likely", "probably" and "may not be" say how sure we are the photo shows this job site, from the camera's distance to the job-site point and how that point was found. A photo is not proof of current conditions. This page includes Google Maps content, subject to the <a href="https://maps.google.com/help/terms_maps/" rel="noopener noreferrer" target="_blank">Google Maps terms</a> and <a href="https://policies.google.com/privacy" rel="noopener noreferrer" target="_blank">Google Privacy Policy</a>.</p>` : ''}`;
    // An image that fails to load says so rather than showing a broken frame.
    for (const img of el.querySelectorAll('figure.photo img')) {
      img.addEventListener('error', () => {
        const fig = img.closest('figure');
        if (fig) fig.outerHTML = '<p class="sub photo-none">Photo: the image did not load from its source.</p>';
      }, { once: true });
    }
  }

  root.Photos = { ...pure, card };
})(typeof window !== 'undefined' ? window : globalThis);
