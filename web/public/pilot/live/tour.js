/* First-visit guided tour of the pilot screens.
 *
 * A short, skippable card that walks through what each screen holds. It
 * opens by itself once, on the overview, for a browser that has not seen it,
 * and again from the "Tour" button in the top bar (or ?tour=1 on any live
 * screen; the search page links there). "Show me" opens that step's screen
 * and the tour carries on there.
 *
 * No server or database state: dismissal is remembered in localStorage only,
 * and every storage call is guarded, so a private window just sees the tour
 * again. All copy is static and ours; nothing third-party is rendered.
 *
 * Wording follows docs/PILOT_UX.md: a missing trade permit is "no permit
 * filed yet", never "not hired"; estimates are called estimates.
 *
 * STEPS and the storage helpers are also required by tour.test.js in Node.
 */
(function (root) {
  const KEY = 'contractos.tour.v1';
  const RESUME = 'contractos.tour.resume';

  // `href` is relative to /pilot/live/ unless it starts with '/'.
  // `page` is the file name the step talks about, so a resumed tour knows it
  // has arrived.
  const STEPS = [
    {
      title: 'What Contractos is',
      body: [
        'Construction permit records from public city and county sources: what is being built, where, when each step was filed, and the business named on each permit, with the source behind every value.',
        'Markets: Austin, Miami-Dade, City of Miami and Raleigh. Data syncs daily, and every screen shows the last sync and how far behind the city publishes.',
      ],
    },
    {
      title: 'Overview',
      page: 'index.html',
      href: 'index.html',
      body: [
        'Building permits issued in the last 30 days for the market you pick, a weekly chart, a map by ZIP, the most active general contractors and the latest permits.',
        'Switch market with the area buttons at the top of the page.',
      ],
    },
    {
      title: 'Early filings',
      page: 'early.html',
      href: 'early.html',
      body: [
        'Building applications that are filed but not issued yet: Austin plan-review cases and Raleigh pre-issue filings. Miami markets publish issued permits only.',
        'A filing has no page of its own. Once it is issued, a "permit issued" link under its stage opens the job page.',
      ],
    },
    {
      title: 'Who filed, and the phone on record',
      page: 'early.html',
      href: 'early.html',
      body: [
        '"Filed by" is the business named on the application, as the city published it. We do not guess whether it is the builder or a permit expediter.',
        'Phone numbers come from the permit records. On a phone, tap one to call. Each says how many permits carry it; nobody has called to check it.',
      ],
    },
    {
      title: 'Builder activity',
      page: 'momentum.html',
      href: 'momentum.html',
      body: [
        'How many building permits each business pulled in the last 60, 90 or 180 days, beside the same span before. Counts only: we do not label anyone as rising or slowing.',
      ],
    },
    {
      title: 'GC relationships',
      page: 'gcs.html',
      href: 'gcs.html',
      body: [
        'For your trade, which subs each general contractor has had on its past permits, which GCs had a different sub on their latest job, and the busiest subs with their top GC. This is history from issued permits, not a sign that a GC is looking for a sub.',
      ],
    },
    {
      title: 'A job and its trade permits',
      page: 'job.html',
      href: 'digest.html',
      cta: 'Open the new permits',
      body: [
        'Open any permit to see its job page: the contractor on the permit, the description as filed, and the electrical, plumbing and HVAC permits filed on the job so far.',
        '"No permit on record" means the source has published none for that trade. It does not mean a sub has not been hired.',
      ],
    },
    {
      title: 'Property, licence and registration',
      page: 'job.html',
      href: 'digest.html',
      cta: 'Open the new permits',
      body: [
        'Job and contractor pages add the county appraiser\'s facts on the property, matched by parcel number, and state licence records (Texas TDLR, Florida DBPR) matched by the licence number on the permit.',
        'Matches by name alone are not shown. Owner names and people are not shown.',
      ],
    },
    {
      title: 'New permits',
      page: 'digest.html',
      href: 'digest.html',
      body: [
        'Building permits we first saw in the last 7, 14 or 30 days, newest first. You can narrow it to jobs with no electrical, plumbing or HVAC permit on record yet.',
      ],
    },
    {
      title: 'Permit search',
      page: 'search.html',
      href: '/search.html',
      body: [
        'Search every permit by area, ZIP, trade and stage, with a map. Open one to see its job details.',
      ],
    },
    {
      title: 'How to read the screens',
      body: [
        'A dotted underline means there is a source behind the value: hover it, or tap it on a phone or tablet.',
        'Every value is read from a public record or counted from records on an official key, such as the permit number. We do not show estimates or guesses. Anything the source does not publish is shown as missing, not filled in.',
        'Replay this tour any time from "Tour" in the top bar.',
      ],
    },
  ];

  // ── Storage (guarded: may throw or be absent) ─────────────
  function get(store, key) { try { return store ? store.getItem(key) : null; } catch (_e) { return null; } }
  function set(store, key, v) { try { if (store) store.setItem(key, v); } catch (_e) { /* private window */ } }
  function del(store, key) { try { if (store) store.removeItem(key); } catch (_e) { /* private window */ } }

  /** Should the tour open on its own on this page load? */
  function shouldAutoOpen({ local, page, search }) {
    if (/(?:^|[?&])tour=0(?:&|$)/.test(search || '')) return false;
    if (/(?:^|[?&])tour=1(?:&|$)/.test(search || '')) return true;
    return page === 'index.html' && get(local, KEY) !== 'done';
  }

  /** Index to resume at, or -1. */
  function resumeStep(session) {
    const v = get(session, RESUME);
    if (v == null || !/^\d+$/.test(v)) return -1;
    const n = Number(v);
    return n < STEPS.length ? n : -1;
  }

  const api = { STEPS, KEY, RESUME, shouldAutoOpen, resumeStep, get, set, del };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  // ── Browser ───────────────────────────────────────────────
  const safe = (fn) => { try { return fn(); } catch (_e) { return null; } };
  const local = safe(() => root.localStorage);
  const session = safe(() => root.sessionStorage);
  const here = () => {
    const p = location.pathname;
    if (p === '/search.html' || p === '/search') return 'search.html';
    return p.split('/').pop() || 'index.html';
  };
  const resolve = (href) => (href.startsWith('/') ? href : `/pilot/live/${href}`);

  let box = null;
  let at = 0;
  let returnFocus = null;

  function finish() {
    set(local, KEY, 'done');
    del(session, RESUME);
    if (box) { box.remove(); box = null; }
    document.removeEventListener('keydown', onKey);
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
    returnFocus = null;
  }

  function onKey(e) {
    if (!box) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(); return; }
    if (e.key !== 'Tab') return;
    // Keep Tab inside the card while it is open.
    const f = [...box.querySelectorAll('a[href], button')];
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function render() {
    const s = STEPS[at];
    const n = STEPS.length;
    const onPage = s.page && s.page === here();
    const target = s.href && s.href.split('/').pop();
    const showMe = s.href && !onPage && target !== here()
      ? `<a class="tour-btn tour-go" href="${resolve(s.href)}" data-step="${at}">${s.cta || 'Show me'}</a>` : '';
    box.innerHTML = `
      <div class="tour-head">
        <span class="tour-count mono">${at + 1} of ${n}</span>
        <button type="button" class="tour-skip" data-act="skip">${at === n - 1 ? 'Close' : 'Skip tour'}</button>
      </div>
      <h2 id="tour-title" tabindex="-1">${s.title}</h2>
      ${onPage ? '<p class="tour-here">You are on this screen.</p>' : ''}
      ${s.body.map((p) => `<p>${p}</p>`).join('')}
      <div class="tour-bar" aria-hidden="true"><i style="width:${Math.round(((at + 1) / n) * 100)}%"></i></div>
      <div class="tour-actions">
        ${at > 0 ? '<button type="button" class="tour-btn" data-act="back">Back</button>' : ''}
        ${showMe}
        <button type="button" class="tour-btn tour-btn--primary" data-act="next">${at === n - 1 ? 'Done' : 'Next'}</button>
      </div>`;
    const h = box.querySelector('#tour-title');
    if (h) h.focus({ preventScroll: true });
  }

  function open(step) {
    at = Math.max(0, Math.min(STEPS.length - 1, step || 0));
    if (!box) {
      returnFocus = document.activeElement;
      box = document.createElement('section');
      box.className = 'tour';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'false');
      box.setAttribute('aria-labelledby', 'tour-title');
      box.addEventListener('click', (e) => {
        const go = e.target.closest('.tour-go');
        if (go) { set(session, RESUME, go.dataset.step); return; } // navigate; resume there
        const act = e.target.closest('[data-act]');
        if (!act) return;
        const a = act.dataset.act;
        if (a === 'skip') finish();
        else if (a === 'back') { at = Math.max(0, at - 1); render(); }
        else if (a === 'next') { if (at === STEPS.length - 1) finish(); else { at += 1; render(); } }
      });
      document.body.appendChild(box);
      document.addEventListener('keydown', onKey);
    }
    render();
  }

  // The "Tour" button in the top bar (live.js topBar) is rendered after this
  // script runs, so listen at the document.
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('[data-tour-open]');
    if (!t) return;
    e.preventDefault();
    // The search page's Screens menu: close it so the card isn't drawn over it.
    const pop = t.closest('[id=screensPop]');
    if (pop) {
      pop.hidden = true;
      const btn = document.getElementById('screensBtn');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
    open(0);
  });

  function start() {
    const resume = resumeStep(session);
    del(session, RESUME);
    if (resume >= 0) { open(resume); return; }
    if (shouldAutoOpen({ local, page: here(), search: location.search })) open(0);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  root.Tour = { open, finish, STEPS };
}(typeof window !== 'undefined' ? window : globalThis));
