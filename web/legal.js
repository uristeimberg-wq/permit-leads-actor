// The site's public notices: terms, privacy, disclaimer, data sources and
// contact. Served before the sign-in gate (web/server.js), so they stay
// public even when REQUIRE_LOGIN=1 puts the app behind a login.
//
// The pages live in web/legal/, not web/public/, because they carry
// placeholders the server fills on each request:
//   {{CONTACT}}  the CONTACT_EMAIL address as a mailto link, or a plain
//                "not published yet" when it is unset or malformed. Never a
//                made-up address (rule 1).
//   {{FOOTER}}   the shared footer (footerHtml), so every notice links to
//                every other one.

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const DIR = path.join(__dirname, 'legal');

/** Path -> file. The order is the footer's order. */
const PAGES = [
  ['/terms', 'terms.html', 'Terms of use'],
  ['/privacy', 'privacy.html', 'Privacy'],
  ['/disclaimer', 'disclaimer.html', 'Disclaimer'],
  ['/sources', 'sources.html', 'Data sources'],
  ['/contact', 'contact.html', 'Contact & removal'],
];

const EMAIL = /^[^\s@<>"'&]+@[^\s@<>"'&]+\.[^\s@<>"'&]+$/;

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The contact address as a link, or an honest "not published yet". */
function contactHtml(env = process.env) {
  const email = String(env.CONTACT_EMAIL || '').trim();
  return EMAIL.test(email)
    ? `<a href="mailto:${esc(email)}">${esc(email)}</a>`
    : '<span class="unset">not published yet</span>';
}

/** The footer every public page shares (also used by the app and SEO pages). */
function footerLinks() {
  return PAGES.map(([href, , label]) => `<a href="${href}">${esc(label)}</a>`).join('');
}
function footerHtml() {
  return `<footer class="legal-foot"><div class="wrap">
  <nav aria-label="Legal">${footerLinks()}</nav>
  <p>© Giboro. Public records as published by the issuing agencies, which may be incomplete or out of date. Not affiliated with or endorsed by any government agency.</p>
</div></footer>`;
}

function render(html, env = process.env) {
  return html.replaceAll('{{CONTACT}}', contactHtml(env)).replaceAll('{{FOOTER}}', footerHtml());
}

/** Express router for the notices. Files are read once; placeholders per request. */
function router({ env = process.env } = {}) {
  const r = express.Router();
  for (const [route, file] of PAGES) {
    const html = fs.readFileSync(path.join(DIR, file), 'utf8');
    r.get(route, (_req, res) => res.type('html').set('Cache-Control', 'no-cache').send(render(html, env)));
  }
  return r;
}

module.exports = { router, render, contactHtml, footerHtml, footerLinks, PAGES };
