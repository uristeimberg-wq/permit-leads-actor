const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { render, contactHtml, footerHtml, PAGES } = require('./legal.js');

const check = (name, fn) => { try { fn(); console.log(`ok   - ${name}`); } catch (e) { console.log(`FAIL - ${name}`); console.error(e); process.exitCode = 1; } };

check('a valid CONTACT_EMAIL becomes a mailto link, escaped', () => {
  assert.strictEqual(contactHtml({ CONTACT_EMAIL: ' hello@giboro.com ' }), '<a href="mailto:hello@giboro.com">hello@giboro.com</a>');
});

check('no address, or a malformed one, says so instead of inventing one (rule 1)', () => {
  for (const v of [undefined, '', 'nobody', 'a@b', '<script>@x.com', 'x"@y.com']) {
    assert.strictEqual(contactHtml({ CONTACT_EMAIL: v }), '<span class="unset">not published yet</span>');
  }
});

check('render fills every placeholder', () => {
  const out = render('{{CONTACT}} {{CONTACT}} {{FOOTER}}', { CONTACT_EMAIL: 'a@b.co' });
  assert.ok(!out.includes('{{'));
  assert.strictEqual(out.split('mailto:a@b.co').length - 1, 2);
});

check('the footer links every notice', () => {
  const f = footerHtml();
  for (const [href] of PAGES) assert.ok(f.includes(`href="${href}"`), href);
});

check('every notice file exists, carries the footer and leaves no placeholder after render', () => {
  for (const [, file] of PAGES) {
    const html = fs.readFileSync(path.join(__dirname, 'legal', file), 'utf8');
    assert.ok(html.includes('{{FOOTER}}'), `${file} has no footer`);
    assert.ok(!/Contractos/.test(html), `${file} has the old name`);
    assert.ok(!render(html, {}).includes('{{'), `${file} left a placeholder`);
  }
});

console.log('\nDone.');
