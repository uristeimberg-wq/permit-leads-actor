// HTML and text for the public, indexable pages (ADR-42). Pure functions of
// the aggregates in db/seo_queries.js, so they are tested offline.
//
// What these pages may show: counts and sums over stored records, the
// source's own permit types and our reviewed stage mapping, sync times and
// source credits. Never a record, address, permit number, contractor, owner
// or phone (docs/COMPLIANCE.md: redistribution is open for several sources;
// contractor identity is only partly verified). Every third-party string goes
// through esc() (hard rule 8).

const { LIFECYCLE_LABEL } = require('../public/stages.js');
const { MARKETS, marketPath, marketSources } = require('./markets.js');

const BRAND = 'Contractos';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const xmlEsc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
// JSON-LD inside <script>: "</script" and "<!--" must not appear raw.
const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')}</script>`;

const int = (n) => (n == null ? null : Math.round(Number(n)).toLocaleString('en-US'));
const usd = (n) => (n == null ? null : `$${Math.round(Number(n)).toLocaleString('en-US')}`);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const longDate = (d) => {
  if (!d) return null;
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  return `${MON[m - 1]} ${day}, ${y}`;
};
const ymd = (d) => (d ? String(d).slice(0, 10) : null);
const stageLabel = (s) => LIFECYCLE_LABEL[s] || LIFECYCLE_LABEL.unknown;
const listAnd = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const placeName = (m) => (m.name === m.stateName ? m.name : `${m.name}, ${m.stateCode}`);
const MISSING = '<span class="na">Not published</span>';

/** Pages with fewer permits than this in 90 days are not rendered (no thin pages). */
const MIN_PERMITS_90 = 50;

/** True when a market has enough live data to deserve a public page. */
const isPublishable = (stats) => Boolean(stats && stats.enabled && stats.lastSyncAt && stats.issued.issued90 >= MIN_PERMITS_90);

// ── Shared page frame ──────────────────────────────────────────────────────

const CSS = `
:root { --paper: oklch(96.4% 0.009 85); --plate: oklch(98.6% 0.005 85); --ink: oklch(22% 0.02 260); --ink-2: oklch(31% 0.018 260);
  --muted: oklch(44% 0.014 260); --line: oklch(84% 0.012 85); --accent: oklch(52% 0.15 48); --accent-deep: oklch(40% 0.12 48);
  --accent-ink: oklch(98.6% 0.005 85); --focus: oklch(50% 0.17 48); --bar: oklch(70% 0.1 48);
  --display: "Oswald", "Arial Narrow", ui-sans-serif, sans-serif; --body: "Archivo", ui-sans-serif, system-ui, sans-serif; }
*, *::before, *::after { box-sizing: border-box; }
html, body { overflow-x: clip; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 400 16px/1.55 var(--body); -webkit-font-smoothing: antialiased; }
.wrap { max-width: 880px; margin: 0 auto; padding: 0 16px; }
header.top { background: var(--ink); }
header.top .wrap { min-height: 52px; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.wordmark { display: flex; align-items: center; gap: 8px; font: 700 20px/1 var(--display); text-transform: uppercase; color: var(--plate); text-decoration: none; min-height: 44px; }
.wordmark i { width: 12px; height: 12px; background: var(--accent); display: inline-block; }
nav.nav { display: flex; gap: 4px 14px; flex-wrap: wrap; }
nav.nav a { color: var(--plate); min-height: 44px; display: inline-flex; align-items: center; text-decoration: none; font-size: 15px; }
nav.nav a:hover { text-decoration: underline; }
main { padding: 20px 0 40px; }
.crumbs { font-size: 14px; color: var(--muted); margin: 0 0 8px; }
.crumbs a { color: var(--accent-deep); }
h1 { font: 700 clamp(1.75rem, 6vw, 2.5rem)/1.05 var(--display); text-transform: uppercase; margin: 0 0 12px; overflow-wrap: anywhere; text-wrap: balance; }
h2 { font: 700 1.3rem/1.15 var(--display); text-transform: uppercase; margin: 32px 0 8px; }
h3 { font: 700 1.05rem/1.2 var(--body); margin: 20px 0 6px; }
p, li, dd { color: var(--ink-2); text-wrap: pretty; }
a { color: var(--accent-deep); }
.facts { background: var(--plate); border: 3px solid var(--ink); padding: 16px 18px; margin: 16px 0 8px; }
.facts p { margin: 0 0 8px; color: var(--ink); }
.facts .stamp { font-size: 14px; color: var(--muted); margin: 0; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 16px 0; padding: 0; list-style: none; }
.kpis li { background: var(--plate); border: 1px solid var(--line); padding: 12px; margin: 0; }
.kpis b { display: block; font: 700 1.6rem/1.1 var(--display); color: var(--ink); }
.kpis span { font-size: 14px; color: var(--muted); }
.tbl { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 8px 0; border: 1px solid var(--line); background: var(--plate); }
table { border-collapse: collapse; width: 100%; font-size: 15px; }
caption { text-align: left; font-size: 14px; color: var(--muted); padding: 8px 10px; caption-side: bottom; }
th, td { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { font-weight: 700; color: var(--ink); background: var(--paper); }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.bar { width: 38%; min-width: 80px; }
td.bar span { display: block; height: 10px; background: var(--bar); }
.na { color: var(--muted); font-style: italic; }
.note { font-size: 14px; color: var(--muted); }
.cta { display: inline-flex; align-items: center; min-height: 44px; padding: 0 18px; background: var(--accent); color: var(--accent-ink); text-decoration: none;
  font: 700 15px/1 var(--display); text-transform: uppercase; letter-spacing: .02em; margin: 8px 0; }
.cta:hover { background: var(--accent-deep); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; padding: 0; list-style: none; }
.cards li { background: var(--plate); border: 3px solid var(--ink); padding: 14px 16px; margin: 0; }
.cards h2 { margin: 0 0 6px; font-size: 1.2rem; }
.cards h2 a { color: var(--ink); text-decoration: none; display: inline-flex; min-height: 44px; align-items: center; }
.cards p { margin: 4px 0; }
dl.faq dt { font-weight: 700; color: var(--ink); margin: 16px 0 4px; }
dl.faq dd { margin: 0; }
ul.src li { margin: 0 0 8px; overflow-wrap: anywhere; }
footer.bottom { border-top: 1px solid var(--line); font-size: 14px; color: var(--muted); }
footer.bottom .wrap { padding-top: 12px; padding-bottom: 20px; display: flex; flex-wrap: wrap; gap: 4px 16px; }
footer.bottom a { min-height: 44px; display: inline-flex; align-items: center; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
@media (max-width: 480px) { table { font-size: 14px; } th, td { padding: 7px 8px; } td.bar, th.bar, .hs { display: none; } }
`;

/**
 * The page frame. `meta`: { title, description, path, base, jsonld: [] }.
 * Titles stay under ~60 characters and descriptions under ~160 where the
 * data allows, so search results do not cut them.
 */
function layout(meta, body) {
  const url = `${meta.base}${meta.path}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${BRAND}">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(meta.title)}">
<meta name="twitter:description" content="${esc(meta.description)}">
${meta.modified ? `<meta property="article:modified_time" content="${esc(meta.modified)}">\n` : ''}<link rel="alternate" type="text/plain" href="${esc(meta.base)}/llms.txt" title="llms.txt">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;700&amp;family=Oswald:wght@700&amp;display=swap" rel="stylesheet">
<style>${CSS}</style>
${(meta.jsonld || []).map(jsonLd).join('\n')}
</head>
<body>
<header class="top"><div class="wrap">
  <a class="wordmark" href="/"><i aria-hidden="true"></i>${BRAND}</a>
  <nav class="nav" aria-label="Site">
    <a href="/markets">Markets</a>
    <a href="/data-methodology">Methodology</a>
    <a href="/search">Open the app</a>
  </nav>
</div></header>
<main class="wrap">
${body}
</main>
<footer class="bottom"><div class="wrap">
  <a href="/sources">Data sources &amp; licenses</a>
  <a href="/data-methodology">Methodology</a>
  <a href="/privacy">Privacy</a>
</div></footer>
<!-- Product analytics (docs/ANALYTICS.md); off under Do Not Track or the /privacy opt-out. -->
<script src="/analytics_core.js" defer></script>
<script src="/analytics.js" defer></script>
</body>
</html>
`;
}

const ORG = (base) => ({ '@type': 'Organization', name: BRAND, url: `${base}/` });

function breadcrumbs(base, items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${base}${path}` })),
  };
}

const crumbsHtml = (items) => `<p class="crumbs">${items.map(([name, path], i) => (i === items.length - 1
  ? `<span aria-current="page">${esc(name)}</span>` : `<a href="${esc(path)}">${esc(name)}</a>`)).join(' / ')}</p>`;

// ── Market facts, in words ─────────────────────────────────────────────────

/** The citation-ready sentences, built only from figures that exist. */
function keyFacts(m, s) {
  const i = s.issued;
  const out = [];
  out.push(`In the 30 days from ${longDate(i.from30)} to ${longDate(i.to)}, ${m.publisher} records show ${int(i.issued30)} permits issued (all permit types).`);
  if (i.valued30) {
    out.push(`${int(i.valued30)} of them list a declared value, totalling ${usd(i.value30)}; the other ${int(i.issued30 - i.valued30)} list none.`);
  } else {
    out.push('None of them lists a declared value.');
  }
  if (s.applications) {
    out.push(`In the same 30 days, ${int(s.applications.filed30)} applications were filed before issue (${s.applicationSources.join(', ')}); ${int(s.applications.beforeIssue30)} of them have no permit issued yet.`);
  } else {
    out.push(`${m.publisher} does not publish application dates in the data we read, so filings before issue are not counted for this market.`);
  }
  out.push(`Over 90 days (from ${longDate(i.from90)}), ${int(i.issued90)} permits were issued.`);
  return out;
}

/** Questions answered with the live figures; the same text is on the page and in FAQPage. */
function faqs(m, s) {
  const i = s.issued;
  const list = [
    [`How many permits were issued in ${m.name} in the last 30 days?`,
      `${int(i.issued30)} permits of all types were issued from ${longDate(i.from30)} to ${longDate(i.to)}, according to ${m.publisher}'s published records as read on ${longDate(s.lastSyncAt)}. Over the last 90 days the count is ${int(i.issued90)}.`],
    [`What is the declared value of permits issued in ${m.name} recently?`,
      i.valued30
        ? `${int(i.valued30)} of the ${int(i.issued30)} permits issued in the last 30 days list a declared value, totalling ${usd(i.value30)}. A value repeated on several permits of one project is counted once. Permits with no declared value are not estimated.`
        : `None of the permits issued in the last 30 days lists a declared value, so no total is given.`],
  ];
  if (s.applications) {
    list.push([`How many permit applications were filed in ${m.name} in the last 30 days?`,
      `${int(s.applications.filed30)} applications were filed from ${longDate(i.from30)} to ${longDate(i.to)} (${s.applicationSources.join(', ')}). ${int(s.applications.beforeIssue30)} of them have no permit issued yet.`]);
  }
  const lag = s.sources.map((x) => x.publicationLag).filter(Boolean);
  list.push([`How current is this ${m.name} permit data?`,
    `We last read ${m.publisher}'s data on ${longDate(s.lastSyncAt)}. The newest issue date in our copy is ${longDate(i.latestIssue) || 'not available'}.${lag.length ? ` ${[...new Set(lag)].join('. ')}.` : ''}`]);
  return list;
}

function datasetLd(m, s, base) {
  const i = s.issued;
  const pv = (name, value, unitText) => (value == null ? null : { '@type': 'PropertyValue', name, value, ...(unitText ? { unitText } : {}) });
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: `${placeName(m)} building permit activity`,
    description: `Counts of building permits issued in ${m.name}, ${m.stateName}, over the last 30 and 90 days, by the permit type ${m.publisher} publishes, with declared values and status today. Aggregated from ${m.publisher}'s public permit records; no individual records are listed.`,
    url: `${base}${marketPath(m)}`,
    isAccessibleForFree: true,
    creator: ORG(base),
    publisher: ORG(base),
    isBasedOn: s.sources.map((x) => x.endpoint).filter(Boolean),
    spatialCoverage: {
      '@type': 'Place',
      name: `${m.name}, ${m.stateName}`,
      address: { '@type': 'PostalAddress', addressLocality: m.name, addressRegion: m.stateCode, addressCountry: 'US' },
    },
    ...(s.history.from && i.latestIssue ? { temporalCoverage: `${s.history.from}/${i.latestIssue}` } : {}),
    dateModified: s.lastSyncAt,
    measurementTechnique: 'Counts of records in the publisher\'s permit data, keyed on the publisher\'s permit number, read by a scheduled sync.',
    variableMeasured: [
      pv(`Permits issued, ${i.from30} to ${i.to}`, i.issued30),
      pv(`Permits issued, ${i.from90} to ${i.to}`, i.issued90),
      pv(`Declared value of permits issued, ${i.from30} to ${i.to}`, i.value30, 'USD'),
      s.applications ? pv(`Applications filed before issue, ${i.from30} to ${i.to}`, s.applications.filed30) : null,
    ].filter(Boolean),
  };
}

function faqLd(list) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: list.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };
}

// ── /markets/<state>/<city> ────────────────────────────────────────────────

function typesTable(s) {
  const t = s.types;
  if (!t.types.length) return '<p class="na">No permits issued in the last 90 days.</p>';
  const row = (label, r) => `<tr><td>${label}</td><td class="n">${int(r.issued30)}</td><td class="n">${int(r.issued90)}</td>`
    + `<td class="n hs">${int(r.valued90)}</td><td class="n">${r.value90 == null ? MISSING : usd(r.value90)}</td></tr>`;
  return `<div class="tbl"><table>
<caption>Permit type as the source publishes it. Declared value: the sum of values listed on permits issued in 90 days; a value repeated on several permits of one project counts once.</caption>
<thead><tr><th scope="col">Permit type</th><th scope="col" class="n">Issued, 30 days</th><th scope="col" class="n">Issued, 90 days</th><th scope="col" class="n hs">With a value</th><th scope="col" class="n">Declared value, 90 days</th></tr></thead>
<tbody>
${t.types.map((r) => row(r.type == null ? '<span class="na">Type not published</span>' : esc(r.type), r)).join('\n')}
${t.other ? row(`${int(t.other.count)} other types`, t.other) : ''}
<tr><th scope="row">All types</th><td class="n"><b>${int(s.issued.issued30)}</b></td><td class="n"><b>${int(s.issued.issued90)}</b></td><td class="n hs">${int(s.issued.valued90)}</td><td class="n">${s.issued.value90 == null ? MISSING : usd(s.issued.value90)}</td></tr>
</tbody></table></div>`;
}

function stagesTable(rows, k30, k90, caption) {
  if (!rows.length) return '<p class="na">None in the last 90 days.</p>';
  const sorted = [...rows].sort((a, b) => b[k90] - a[k90] || String(a.stage).localeCompare(String(b.stage)));
  return `<div class="tbl"><table>
<caption>${esc(caption)}</caption>
<thead><tr><th scope="col">Status today</th><th scope="col" class="n">Last 30 days</th><th scope="col" class="n">Last 90 days</th></tr></thead>
<tbody>
${sorted.map((r) => `<tr><td>${esc(stageLabel(r.stage))}</td><td class="n">${int(r[k30])}</td><td class="n">${int(r[k90])}</td></tr>`).join('\n')}
</tbody></table></div>`;
}

function weeklyTable(weeks) {
  const max = Math.max(1, ...weeks.map((w) => w.issued || 0));
  return `<div class="tbl"><table>
<caption>Full weeks, Monday to Sunday. The current week is left out because the source publishes with a lag.</caption>
<thead><tr><th scope="col">Week of</th><th scope="col" class="n">Permits issued</th><th scope="col" class="bar"><span class="na">Relative</span></th></tr></thead>
<tbody>
${weeks.map((w) => `<tr><td>${esc(longDate(w.weekOf))}</td><td class="n">${w.issued == null ? '<span class="na">Before our history</span>' : int(w.issued)}</td><td class="bar">${w.issued ? `<span style="width:${Math.round((w.issued / max) * 100)}%"></span>` : ''}</td></tr>`).join('\n')}
</tbody></table></div>`;
}

function marketPage(m, s, base) {
  const i = s.issued;
  const path = marketPath(m);
  const title = `${placeName(m)} building permits: last 30 and 90 days`;
  const description = `${int(i.issued30)} permits issued in ${m.name} from ${longDate(i.from30)} to ${longDate(i.to)}, by permit type and status, from ${m.publisher}'s public records. Updated ${longDate(s.lastSyncAt)}.`;
  const crumbs = [['Markets', '/markets'], [placeName(m), path]];
  const facts = keyFacts(m, s);
  const qa = faqs(m, s);
  const lags = [...new Set(s.sources.map((x) => x.publicationLag).filter(Boolean))];
  const syncLine = s.oldestSyncAt && ymd(s.oldestSyncAt) !== ymd(s.lastSyncAt)
    ? ` (oldest source read ${esc(ymd(s.oldestSyncAt))})` : '';

  const body = `${crumbsHtml(crumbs)}
<h1>${esc(placeName(m))} building permits</h1>
<p>${esc(m.scope)}</p>

<section class="facts" aria-labelledby="kf">
  <h2 id="kf" style="margin-top:0">Key facts</h2>
  ${facts.map((f) => `<p>${esc(f)}</p>`).join('\n  ')}
  <p class="stamp">Last updated: <time datetime="${esc(ymd(s.lastSyncAt))}">${esc(ymd(s.lastSyncAt))}</time>${syncLine}. Newest issue date in our copy: ${i.latestIssue ? `<time datetime="${esc(i.latestIssue)}">${esc(i.latestIssue)}</time>` : 'none'}.${lags.length ? ` ${esc(lags.join('. '))}.` : ''}</p>
</section>

<ul class="kpis" aria-label="Headline counts">
  <li><b>${int(i.issued30)}</b><span>permits issued, last 30 days</span></li>
  <li><b>${int(i.issued90)}</b><span>permits issued, last 90 days</span></li>
  <li><b>${i.value30 == null ? '—' : usd(i.value30)}</b><span>declared value, last 30 days (${int(i.valued30)} permits list one)</span></li>
  <li><b>${s.applications ? int(s.applications.filed30) : '—'}</b><span>${s.applications ? 'applications filed before issue, last 30 days' : 'applications before issue: not published'}</span></li>
</ul>

<h2>Permits issued by type</h2>
${typesTable(s)}

${s.applications ? `<h2>Applications filed before issue</h2>
<p>${int(s.applications.filed90)} applications filed in the last 90 days (${esc(s.applicationSources.join(', '))}), by where they stand today. ${int(s.applications.beforeIssue90)} of them have no permit issued yet (pre-application, submitted, in review, corrections requested, or approved but not issued).</p>
${stagesTable(s.applications.stages, 'filed30', 'filed90', 'Status is the source\'s own wording, mapped to one stage by a reviewed table per source. "Stage not mapped" means the source used a status we have not mapped.')}` : `<h2>Applications filed before issue</h2>
<p class="na">${esc(m.publisher)} does not publish application dates in the data we read, so this market has no count of filings before issue. We show nothing rather than a zero.</p>`}

<h2>Status today of permits issued</h2>
${stagesTable(s.issuedStages, 'issued30', 'issued90', 'Permits issued in each window, by the status the source shows today. "Stage not mapped" means the source used a status we have not mapped.')}

<h2>Permits issued per week</h2>
${weeklyTable(s.weekly)}

<h2>Questions</h2>
<dl class="faq">
${qa.map(([q, a]) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join('\n')}
</dl>

<h2>Search the records</h2>
<p>This page shows counts only. The app lists the permits themselves, with the business named on each permit where the source publishes one.</p>
<a class="cta" href="/search?areas=${encodeURIComponent(m.appAreas)}">Search ${esc(m.name)} permits</a>

<h2>Source</h2>
<ul class="src">
${s.sources.map((x) => `<li>${esc(x.label)}: ${esc(x.attribution || 'credit not recorded')}. Last read ${x.lastSyncAt ? esc(ymd(x.lastSyncAt)) : 'never'}.</li>`).join('\n')}
</ul>
<p class="note">We hold ${int(s.history.records)} ${esc(m.name)} permits${s.history.from ? `, issued from ${esc(longDate(s.history.from))}` : ''}. Not affiliated with or endorsed by ${esc(m.publisher)}. How we count: <a href="/data-methodology">methodology</a>.</p>`;

  return layout({
    title, description, path, base, modified: s.lastSyncAt,
    jsonld: [breadcrumbs(base, crumbs), datasetLd(m, s, base), faqLd(qa)],
  }, body);
}

// ── / (the public home page, for visitors who have not opened the app) ────

/** `list`: [{ market, stats }] for publishable markets. Facts only: no claims about who the customers are. */
function homePage(list, base) {
  const total30 = list.reduce((n, x) => n + x.stats.issued.issued30, 0);
  const records = list.reduce((n, x) => n + x.stats.history.records, 0);
  const newest = list.map((x) => x.stats.lastSyncAt).filter(Boolean).sort().pop() || null;
  const names = MARKETS.map(placeName);
  const title = `${BRAND}: building permit data for Austin, Miami and Raleigh`;
  const description = `Search building permits published by ${listAnd(MARKETS.map((m) => m.publisher))}, with the public record behind every value. Updated daily.`;
  const body = `<h1>Building permit data from public records</h1>
<p>${BRAND} reads the building permit records that ${esc(listAnd(MARKETS.map((m) => m.publisher)))} publish, and lets you search them with the source record behind every value.</p>
<a class="cta" href="/search">Open the app</a>
${list.length ? `<section class="facts" aria-labelledby="now">
  <h2 id="now" style="margin-top:0">Right now</h2>
  <p>${int(total30)} permits were issued in the last 30 days ${list.length === 1 ? 'in the market below' : `across the ${int(list.length)} markets below`}, and we hold ${int(records)} permits in all.</p>
  <p class="stamp">Last updated: <time datetime="${esc(ymd(newest))}">${esc(ymd(newest))}</time>. Each market page gives its own date and the source's publication lag.</p>
</section>
<ul class="cards">
${list.map(({ market: m, stats: s }) => `<li>
  <h2><a href="${esc(marketPath(m))}">${esc(placeName(m))}</a></h2>
  <p><b>${int(s.issued.issued30)}</b> permits issued, last 30 days</p>
  <p class="note">Source: ${esc(m.publisher)}. Updated ${esc(ymd(s.lastSyncAt))}.</p>
</li>`).join('\n')}
</ul>` : ''}
<h2>What the app does</h2>
<ul>
  <li>Search permits by place (ZIP, city or whole market), stage, permit type, declared value and keywords in the work description.</li>
  <li>See permits on a map, and open any permit to read what the source published about it.</li>
  <li>See the business named on each permit, with the phone number where the permit record lists one. Owner names and contacts of individuals are withheld.</li>
  <li>In Austin and Raleigh, see applications before a permit is issued, where the city publishes them.</li>
  <li>Save permits to come back to.</li>
</ul>
<p>Covered: ${esc(names.join('; '))}. No other place is covered. Missing values are shown as missing, never estimated. How we count: <a href="/data-methodology">methodology</a>.</p>
<a class="cta" href="/search">Open the app</a>`;
  return layout({
    title, description, path: '/', base, modified: newest,
    jsonld: [
      { '@context': 'https://schema.org', ...ORG(base), url: `${base}/` },
      { '@context': 'https://schema.org', '@type': 'WebSite', name: BRAND, url: `${base}/` },
    ],
  }, body);
}

// ── /markets ───────────────────────────────────────────────────────────────

/** `list`: [{ market, stats }] for publishable markets only. */
function marketsIndex(list, base) {
  const title = 'Building permit activity by market';
  const description = `Live counts of building permits issued in ${list.map(({ market }) => market.name).join(', ')}, from each city's or county's public permit records.`;
  const body = `<h1>Building permit markets</h1>
<p>Counts of permits issued in each market we read, updated from the publisher's own records. Each page states when it was last read.</p>
<ul class="cards">
${list.map(({ market: m, stats: s }) => `<li>
  <h2><a href="${esc(marketPath(m))}">${esc(placeName(m))}</a></h2>
  <p><b>${int(s.issued.issued30)}</b> permits issued, last 30 days</p>
  <p><b>${int(s.issued.issued90)}</b> permits issued, last 90 days</p>
  <p class="note">Source: ${esc(m.publisher)}. Last updated ${esc(ymd(s.lastSyncAt))}.</p>
</li>`).join('\n')}
</ul>
${list.length ? '' : '<p class="na">No market has enough recent data to show right now.</p>'}
<p class="note">Only these markets are covered. How we count: <a href="/data-methodology">methodology</a>.</p>`;
  const crumbs = [['Markets', '/markets']];
  return layout({
    title, description, path: '/markets', base,
    jsonld: [
      { '@context': 'https://schema.org', ...ORG(base) },
      breadcrumbs(base, crumbs),
      {
        '@context': 'https://schema.org', '@type': 'ItemList', name: title,
        itemListElement: list.map(({ market: m }, i) => ({ '@type': 'ListItem', position: i + 1, name: placeName(m), url: `${base}${marketPath(m)}` })),
      },
    ],
  }, body);
}

// ── /data-methodology ──────────────────────────────────────────────────────

function methodologyPage(sources, base) {
  const title = 'Data methodology and sources';
  const description = 'Where Contractos permit data comes from, how often it is read, how records are counted and what is withheld.';
  const used = new Set(MARKETS.flatMap(marketSources));
  const permits = sources.filter((x) => used.has(x.slug));
  const body = `${crumbsHtml([['Markets', '/markets'], ['Methodology', '/data-methodology']])}
<h1>Data methodology</h1>
<p>${BRAND} reads public permit records from city and county open-data services and keeps every value tied to the record it came from. This page explains what we read, how often, and how the counts on the market pages are made.</p>

<h2>What we cover</h2>
<p>${MARKETS.map((m) => `<a href="${esc(marketPath(m))}">${esc(placeName(m))}</a>`).join(', ')}. No other city or county is covered; we do not extrapolate to places we do not read.</p>

<h2>How the data is read</h2>
<ul>
  <li>A scheduled sync reads each source's own published service once a day. Each run is logged with its outcome, including failures.</li>
  <li>Every record is stored with the raw record it came from, so any value can be traced back to the publisher's row.</li>
  <li>Re-reading a record updates it in place, keyed on the publisher's permit number; it is never counted twice.</li>
  <li>Sources publish with a lag, listed for each source below. Each market page states the last time we read the source and the newest issue date in our copy.</li>
</ul>

<h2>How the market pages count</h2>
<ul>
  <li><b>Permits issued</b>: records whose issue date, as the source publishes it, falls in the window. Windows end on the day the page was computed and include it. A date in the future is left out.</li>
  <li><b>Permit type</b>: the source's own type wording, unchanged. We do not assign trades or categories of our own on these pages.</li>
  <li><b>Declared value</b>: the value written on the permit. Values under $100 or of $1 billion and more are treated as missing. A value repeated on several permits of one project is counted once. Missing values are never estimated.</li>
  <li><b>Applications filed before issue</b>: only where the source publishes an application date (Austin plan-review cases; Raleigh applied dates). Miami-Dade and the City of Miami publish none, so no count is shown for them.</li>
  <li><b>Status today</b>: the source's status wording, mapped to one stage by a table reviewed for each source. A status we have not mapped is shown as "Stage not mapped", not guessed.</li>
  <li>A market page is published only when the market has a successful sync and at least ${MIN_PERMITS_90} permits issued in 90 days.</li>
</ul>

<h2>What is not shown publicly</h2>
<ul>
  <li>No individual permit, address, permit number, contractor, owner or phone number appears on these public pages: they show counts only.</li>
  <li>In the app, owner names and contacts of individuals are withheld. Contacts shown there come from the public permit record.</li>
  <li>We do not show lead scores or say what a business intends to do.</li>
</ul>

<h2>Sources</h2>
<ul class="src">
${permits.map((x) => `<li><b>${esc(x.label)}</b>: ${esc(x.attribution || 'credit not recorded')}.${x.publicationLag ? ` ${esc(x.publicationLag)}.` : ''} Last read ${x.lastSyncAt ? esc(ymd(x.lastSyncAt)) : 'never'}.</li>`).join('\n')}
</ul>
<p>Every source credit, including property, licence and business records used in the app, is on <a href="/sources">Data sources and licenses</a>. Data licensed under <a href="https://creativecommons.org/licenses/by/4.0/" rel="noopener noreferrer">CC BY 4.0</a> (City of Miami, Wake County) was normalized by us: fields renamed, statuses grouped, duplicates merged. Not affiliated with or endorsed by these agencies. Data as published, and may be incomplete.</p>`;
  return layout({
    title, description, path: '/data-methodology', base,
    jsonld: [
      breadcrumbs(base, [['Markets', '/markets'], ['Methodology', '/data-methodology']]),
      { '@context': 'https://schema.org', '@type': 'WebPage', name: title, description, url: `${base}/data-methodology`, publisher: ORG(base) },
    ],
  }, body);
}

// ── robots.txt, sitemap.xml, llms.txt ──────────────────────────────────────

// Search and AI-answer crawlers named so the intent is explicit. A named group
// replaces the * group for that crawler, so each repeats the same rules.
const CRAWLERS = ['Googlebot', 'Bingbot', 'Applebot', 'DuckDuckBot', 'OAI-SearchBot', 'ChatGPT-User', 'GPTBot', 'PerplexityBot', 'Perplexity-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User'];
const DISALLOW = ['/api/', '/admin', '/digest/', '/login', '/logout', '/pilot/'];

function robotsTxt(base) {
  const rules = ['Allow: /', ...DISALLOW.map((p) => `Disallow: ${p}`)].join('\n');
  return `# ${BRAND}: public market pages are open to search and AI crawlers.
# The app itself sends noindex; its data APIs and owner pages are off limits.
${[...CRAWLERS, '*'].map((ua) => `User-agent: ${ua}\n${rules}`).join('\n\n')}

Sitemap: ${base}/sitemap.xml
`;
}

/** `urls`: [{ path, lastmod }]. */
function sitemapXml(base, urls) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${xmlEsc(base + u.path)}</loc>${u.lastmod ? `<lastmod>${xmlEsc(ymd(u.lastmod))}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`;
}

function marketMd(m, s, base) {
  return `## ${placeName(m)}

- Page: ${base}${marketPath(m)}
- Last updated: ${ymd(s.lastSyncAt)}; newest issue date in our copy: ${s.issued.latestIssue || 'none'}
${keyFacts(m, s).map((f) => `- ${f}`).join('\n')}
- Source: ${s.sources.map((x) => `${x.label} (${x.attribution || 'credit not recorded'})`).join('; ')}
`;
}

/** `list`: [{ market, stats }] for publishable markets. `full` adds every market's key facts. */
function llmsTxt(base, list, { full = false } = {}) {
  const head = `# ${BRAND}

> ${BRAND} turns public building permit records from city and county open-data services into searchable permit data, with the source record behind every value. Covered markets: ${MARKETS.map(placeName).join('; ')}. No other places are covered.

Facts on the market pages are counts of the publishers' own records, recomputed from our database after each daily sync. Each page states when its source was last read and the newest issue date we hold. Permit types are the publishers' own wording; we add no trade categories, scores or estimates on these pages, and no individual records, addresses, contractors or phone numbers appear on them.

## Markets

- [Home](${base}/): what the app does and the latest counts
${list.map(({ market: m, stats: s }) => `- [${placeName(m)} building permits](${base}${marketPath(m)}): ${int(s.issued.issued30)} permits issued in the 30 days to ${s.issued.to}; updated ${ymd(s.lastSyncAt)}`).join('\n')}

## Methodology

- [Data methodology](${base}/data-methodology): sources and their credits, sync schedule, how permits, values and statuses are counted, and what is withheld

## Optional

- [Full facts for every market](${base}/llms-full.txt)
- [The app](${base}/search): search the permits themselves
`;
  if (!full) return head;
  return `${head}
# Market facts

${list.map(({ market: m, stats: s }) => marketMd(m, s, base)).join('\n')}`;
}

module.exports = {
  homePage, layout, marketPage, marketsIndex, methodologyPage, robotsTxt, sitemapXml, llmsTxt,
  keyFacts, faqs, datasetLd, isPublishable, esc, MIN_PERMITS_90, CRAWLERS, DISALLOW,
};
