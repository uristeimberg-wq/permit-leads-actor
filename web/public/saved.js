// Saved permits: the heart button, the email sign-in dialog and the account
// corner of the header. Exposes window.Saved for app.js (cards, drawer and the
// /saved view). Talks to /api/me (web/users.js).
//
// Sign-in is email only, with no check that the address is yours (owner
// decision for the pilot). The dialog says so, so nobody stores anything
// private in a note.
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (id) => document.getElementById(id);

  const STATUS_LABELS = {
    saved: 'Saved', called: 'Called', no_answer: 'No answer', quoted: 'Quote sent',
    won: 'Won', lost: 'Lost', not_relevant: 'Not relevant',
  };

  let me = { email: null };
  const saved = new Map();          // permitId -> status
  let pending = null;               // an action waiting for sign-in

  const HEART = (filled) => `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"
    fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
    <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.5 8 3.6 4.5 7.2 4.5c2 0 3.6 1.1 4.8 2.8 1.2-1.7 2.8-2.8 4.8-2.8 3.6 0 5.7 3.5 4.5 6.8-1.8 4.6-9.3 9.2-9.3 9.2Z"/></svg>`;

  /** A heart for one permit. `label` adds the word, for the drawer. */
  function heartHtml(permitId, { label = false } = {}) {
    const id = String(permitId);
    const on = saved.has(id);
    return `<button type="button" class="heart${label ? ' heart-label' : ''}" data-heart="${esc(id)}" aria-pressed="${on}"
      aria-label="${on ? 'Remove from saved' : 'Save this permit'}" title="${on ? 'Saved — click to remove' : 'Save this permit'}">
      ${HEART(on)}${label ? `<span>${on ? 'Saved' : 'Save'}</span>` : ''}</button>`;
  }

  function paintHearts(id) {
    for (const b of document.querySelectorAll(id ? `[data-heart="${CSS.escape(id)}"]` : '[data-heart]')) {
      const on = saved.has(b.dataset.heart);
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', on ? 'Remove from saved' : 'Save this permit');
      b.title = on ? 'Saved — click to remove' : 'Save this permit';
      b.innerHTML = `${HEART(on)}${b.classList.contains('heart-label') ? `<span>${on ? 'Saved' : 'Save'}</span>` : ''}`;
    }
  }

  function paintAccount() {
    const acct = $('account');
    if (acct) {
      acct.innerHTML = me.email
        ? `<span class="acct-email" title="Signed in as ${esc(me.email)}">${esc(me.email)}</span><a class="signout" href="/logout" data-track="logout">Sign out</a>`
        : '<button type="button" class="signout" data-signin>Sign in</button>';
    }
    const n = $('savedCount');
    if (n) { n.textContent = saved.size ? String(saved.size) : ''; n.hidden = !saved.size; }
  }

  const changed = () => { paintAccount(); window.dispatchEvent(new Event('saved:change')); };

  async function api(method, url, body) {
    let r;
    try {
      r = await fetch(url, {
        method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error("Couldn't reach the server. Check your connection, or that the Contractos server is running.");
    }
    // A web page instead of JSON means another app is answering on this address.
    if (!(r.headers.get('content-type') || '').includes('application/json')) {
      const err = new Error(`The server answered with a web page instead of data (HTTP ${r.status}). Another app may be running on this address.`);
      err.status = r.status;
      throw err;
    }
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && data.signIn) { me = { email: null }; saved.clear(); paintAccount(); paintHearts(); }
    if (!r.ok) { const err = new Error(data.error || `Request failed (${r.status})`); err.status = r.status; throw err; }
    return data;
  }

  async function refresh() {
    try {
      const d = await api('GET', '/api/me');
      me = { email: d.email };
      saved.clear();
      for (const s of d.saved || []) saved.set(String(s.permitId), s.status);
    } catch { /* signed-out view still works */ }
    paintHearts();
    changed();
  }

  /** Runs `fn` now if signed in, else after the email dialog succeeds. */
  function withUser(fn) {
    if (me.email) return fn();
    pending = fn;
    openSignin();
    return undefined;
  }

  const track = (name, props, ctx) => { try { if (window.Track) window.Track.event(name, props, ctx); } catch { /* never in the way */ } };

  async function toggle(permitId) {
    const id = String(permitId);
    return withUser(async () => {
      const was = saved.get(id);
      try {
        if (was) { saved.delete(id); paintHearts(id); changed(); await api('DELETE', `/api/me/saved/${encodeURIComponent(id)}`); }
        else { saved.set(id, 'saved'); paintHearts(id); changed(); await api('PUT', `/api/me/saved/${encodeURIComponent(id)}`, {}); }
        track(was ? 'record_unsaved' : 'record_saved', {}, { target_record_id: id, target_entity_type: 'permit' });
      } catch (err) {
        // Put the heart back the way the server has it.
        if (was) saved.set(id, was); else saved.delete(id);
        paintHearts(id); changed();
        if (err.status !== 401) alert(err.message);
      }
    });
  }

  async function update(permitId, patch) {
    const id = String(permitId);
    const r = await api('PUT', `/api/me/saved/${encodeURIComponent(id)}`, patch);
    saved.set(id, r.status);
    changed();
    return r;
  }

  async function remove(permitId) {
    const id = String(permitId);
    await api('DELETE', `/api/me/saved/${encodeURIComponent(id)}`);
    saved.delete(id);
    paintHearts(id);
    changed();
  }

  // ── the email dialog ───────────────────────────────────────────────────
  const dlg = document.createElement('dialog');
  dlg.className = 'welcome signin';
  dlg.id = 'signinDlg';
  dlg.setAttribute('aria-labelledby', 'signinTitle');
  dlg.innerHTML = `
    <form class="welcome-body" novalidate>
      <div class="welcome-head">
        <h2 id="signinTitle">Save permits to your list</h2>
        <p>Enter your email to keep the permits you save, mark who you called, and add notes.
           Next time, sign in with the same email.</p>
      </div>
      <label class="loc-label" for="signinEmail">Email</label>
      <input class="input" id="signinEmail" name="email" type="email" autocomplete="email" inputmode="email" maxlength="254" required>
      <p class="hint" id="signinErr" role="alert" hidden></p>
      <p class="welcome-note">We don't check the address or send you mail. Anyone who types your
        email can see this list, so keep notes free of anything private.</p>
      <div class="welcome-foot">
        <button type="button" class="btn btn-ghost" id="signinCancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Continue</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form');

  function openSignin() {
    if (!dlg.open) track('signup_started', { trigger: pending ? 'save' : 'button' });
    $('signinErr').hidden = true;
    if (!dlg.open) dlg.showModal();
    $('signinEmail').focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('signinErr');
    try {
      const d = await api('POST', '/api/me/signin', { email: $('signinEmail').value });
      me = { email: d.email };
      // The next telemetry batch carries the session cookie: the server links
      // this device's earlier activity to the user (web/telemetry.js).
      if (window.Track) window.Track.identify(d.created ? 'signup' : 'login');
      dlg.close();
      await refresh();
      const fn = pending; pending = null;
      if (fn) await fn();
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
    }
  });
  $('signinCancel').addEventListener('click', () => { pending = null; dlg.close(); });
  dlg.addEventListener('cancel', () => { pending = null; });

  // One delegated handler for every heart and "Sign in" button on the page.
  document.addEventListener('click', (e) => {
    const heart = e.target.closest('[data-heart]');
    if (heart) { e.preventDefault(); e.stopPropagation(); toggle(heart.dataset.heart); return; }
    if (e.target.closest('[data-signin]')) { e.preventDefault(); openSignin(); }
  }, true);

  paintAccount();
  window.Saved = {
    ready: refresh(),
    heartHtml, toggle, update, remove, openSignin, withUser,
    api: (method, url, body) => api(method, url, body),
    isSaved: (id) => saved.has(String(id)),
    email: () => me.email,
    STATUS_LABELS,
  };
})();
