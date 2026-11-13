// Accela Citizen Access adapter — covers any ACA-hosted agency (Clackamas
// County and Oregon statewide ePermitting both run it).
//
// Everything here was derived from real saved HTML (see recon/), not guessed:
//  - Search is an ASP.NET postback on #ctl00_PlaceHolderMain_btnNewSearch.
//  - The date inputs are MaskedEdit fields that track a ClientState updated by
//    key events, so they must be TYPED. A plain fill() leaves them looking
//    empty to validation and the search lands on Error.aspx.
//  - Results land in #ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList,
//    10 per page, paged by numbered postback links.
//  - The grid has NO description and NO valuation. Both live on the detail
//    page, which is a plain GET (CapDetail.aspx?capID1=..&capID2=..&capID3=..).

const { chromium } = require('playwright');
const { createStatusNormalizer, normalizePermit } = require('../normalize.js');

const SEL = {
  startDate: '#ctl00_PlaceHolderMain_generalSearchForm_txtGSStartDate',
  endDate: '#ctl00_PlaceHolderMain_generalSearchForm_txtGSEndDate',
  search: '#ctl00_PlaceHolderMain_btnNewSearch',
  grid: '#ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList',
};

// ACA validates these fields strictly as MM/dd/yyyy — an unpadded "9/4/2026"
// is rejected with "Enter as MM/dd/yyyy" and no results ever render.
const pad = (n) => String(n).padStart(2, '0');
const formatDate = (d) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ACA sits behind a CDN that intermittently stalls a request outright. One
 * timeout doesn't mean the portal is down, so navigation is retried with a
 * backoff before the whole run is failed.
 */
async function gotoWithRetry(page, url, { log, attempts = 3, timeout = 60000 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    } catch (err) {
      lastErr = err;
      if (log && i < attempts) log.warning(`  navigation attempt ${i}/${attempts} failed (${err.message.split('\n')[0]}); retrying`);
      await sleep(2000 * i);
    }
  }
  throw lastErr;
}

/** Types into a MaskedEdit date field so its ClientState updates. */
async function typeDate(page, selector, date) {
  await page.click(selector);
  await page.fill(selector, '');
  await page.type(selector, formatDate(date), { delay: 50 });
  await page.keyboard.press('Tab');
}

// ACA instances label the same columns differently — Clackamas has
// "Date"/"Permit Number", Oregon statewide has "Opened"/"Permit/Application
// Number" and no Project Name at all. Matching by alias rather than exact
// header (or worse, column position) keeps one adapter working across both.
const HEADER_ALIASES = {
  filedDate: ['date', 'opened', 'file date', 'date opened'],
  permitNumber: ['permit number', 'permit/application number', 'record number', 'permit'],
  permitType: ['permit type', 'record type', 'type'],
  projectName: ['project name', 'project'],
  address: ['address', 'site address', 'work location', 'project address'],
  status: ['status', 'record status', 'permit status'],
  shortNotes: ['short notes', 'description', 'notes'],
  // Oregon statewide spans many jurisdictions and names each one here
  // (e.g. "YAMHILL_CO"). Clackamas has no such column; the source label fills in.
  agency: ['agency', 'jurisdiction'],
};

/**
 * Turns the results grid into records, keyed by header name rather than column
 * position so an added column doesn't silently shift every field.
 */
async function extractGridPage(page) {
  return page.$$eval(`${SEL.grid} tr`, (rows, aliases) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    let headers = null;
    const out = [];

    for (const tr of rows) {
      const ths = [...tr.querySelectorAll('th')].map((th) => clean(th.innerText));
      if (ths.filter(Boolean).length >= 4) {
        headers = ths;
        continue;
      }
      const link = tr.querySelector('a[href*="CapDetail"]');
      if (!link || !headers) continue;

      const cells = [...tr.querySelectorAll('td')].map((td) => clean(td.innerText));
      const at = (field) => {
        for (const alias of aliases[field]) {
          const i = headers.findIndex((h) => h.toLowerCase() === alias);
          if (i >= 0 && (cells[i] ?? '') !== '') return cells[i];
        }
        return '';
      };

      out.push({
        filedDate: at('filedDate'),
        permitNumber: at('permitNumber') || clean(link.innerText),
        permitType: at('permitType'),
        projectName: at('projectName'),
        address: at('address'),
        status: at('status'),
        shortNotes: at('shortNotes'),
        agency: at('agency'),
        detailUrl: link.href,
      });
    }
    return out;
  }, HEADER_ALIASES);
}

/** Clicks the numbered pager link for `pageNumber`. Returns false if absent. */
async function gotoPage(page, pageNumber) {
  const link = page.locator(`${SEL.grid} a`).filter({ hasText: new RegExp(`^${pageNumber}$`) }).first();
  if ((await link.count()) === 0) return false;
  const firstBefore = await page.locator(`${SEL.grid} a[href*="CapDetail"]`).first().innerText().catch(() => '');
  await link.click();
  // The grid reloads inside an UpdatePanel; wait for its contents to change.
  await page
    .waitForFunction(
      ([sel, prev]) => {
        const a = document.querySelector(`${sel} a[href*="CapDetail"]`);
        return a && a.innerText.trim() !== prev;
      },
      [SEL.grid, firstBefore],
      { timeout: 60000 },
    )
    .catch(() => {});
  return true;
}


// --- Fees and Inspections tabs -------------------------------------------
//
// Both are lazily AJAX-loaded: the detail HTML ships "Fees Loading..." and
// "Inspections Loading..." placeholders, so this content does NOT come with the
// page and has to be requested by activating the tab. That makes these the
// expensive fields — everything else on the detail page is free.
//
// The tab links carry onclick="return false" and are hidden behind an overflow
// menu at narrow widths, so the click is dispatched directly on the element.

const TAB_LINK = {
  fee: 'a[href="#tab-fee"]',
  inspections: 'a[href="#tab-inspections"]',
};

const money = (text) => {
  const m = String(text || '').match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/);
  return m ? Number(m[1].replace(/,/g, '')) : 0;
};

/** Activates a tab and waits for its "Loading..." placeholder to be replaced. */
async function openTab(page, name) {
  const selector = TAB_LINK[name];
  if ((await page.locator(selector).count()) === 0) return null;

  await page.evaluate((sel) => document.querySelector(sel)?.click(), selector);
  const panelId = `#tab-${name}`;
  await page
    .waitForFunction(
      (id) => {
        const el = document.querySelector(id);
        return el && el.innerText && !/Loading\.\.\./.test(el.innerText);
      },
      panelId,
      { timeout: 20000 },
    )
    .catch(() => {}); // fall through and parse whatever rendered
  return page.locator(panelId);
}

/**
 * Fee line items plus paid/outstanding totals.
 * Table columns observed live: Date | Invoice Number | Amount.
 */
async function fetchFees(page) {
  const panel = await openTab(page, 'fee');
  if (!panel) return { fees: [], feesPaid: 0, feesBalance: 0 };

  const rows = await panel
    .locator('tr')
    .evaluateAll((trs) =>
      trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\s+/g, ' ').trim())),
    )
    .catch(() => []);

  const fees = rows
    .filter((cells) => cells.length >= 3 && /\d{1,2}\/\d{1,2}\/\d{4}/.test(cells[0]))
    .map((cells) => ({ date: cells[0], invoice: cells[1], amount: cells[2] }));

  const text = await panel.innerText().catch(() => '');
  const paid = text.match(/Total paid fees:\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const due = text.match(/Total (?:unpaid|outstanding|due) fees?:\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);

  return {
    fees,
    // Prefer the portal's own total; fall back to summing the line items so a
    // layout change doesn't silently report $0 when fees clearly exist.
    feesPaid: paid ? money(paid[1]) : fees.reduce((sum, f) => sum + money(f.amount), 0),
    feesBalance: due ? money(due[1]) : 0,
  };
}

const INSPECTION_GRIDS = [
  ['scheduled', 'ctl00_PlaceHolderMain_InspectionList_gvListUpcoming'],
  ['completed', 'ctl00_PlaceHolderMain_InspectionList_gvListCompleted'],
];

const DATE_LINE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

/**
 * Parses one inspection row's text. The two grids render differently, and
 * reading a scheduled row with the completed layout puts the scheduled DATE in
 * the result field — which is how this was caught.
 *
 *   completed: "Approved" / "199 Electrical Final" / "Result by: DD on 09/11/2026"
 *   scheduled: "09/16/2026" / "Scheduled 120 Rough-in/Cover/Ditch Cover"
 *
 * Pure so it can be tested without a browser.
 */
function parseInspectionRow(text, status) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && l !== 'View Details' && l !== 'Actions');
  if (lines.length === 0) return null;

  if (status === 'scheduled') {
    const date = lines.find((l) => DATE_LINE.test(l)) || null;
    const type = lines.find((l) => !DATE_LINE.test(l)) || null;
    return {
      status,
      // "Scheduled 120 Rough-in/..." — the word is the grid's label, not part
      // of the inspection type.
      type: type ? type.replace(/^Scheduled\s+/i, '') : null,
      date,
      result: null,
      inspector: null,
    };
  }

  const byLine = lines.find((l) => /^Result by:/i.test(l)) || '';
  const by = byLine.match(/Result by:\s*(.*?)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const result = lines[0] || null;
  const type = lines.find((l, i) => i > 0 && !/^Result by:/i.test(l)) || null;

  return {
    status,
    type,
    date: by ? by[2] : null,
    result,
    inspector: by ? by[1] : null,
  };
}

/** Scheduled and completed inspections, read from their separate grids. */
async function fetchInspections(page) {
  const panel = await openTab(page, 'inspections');
  if (!panel) return { inspections: [] };

  const rows = await page
    .evaluate((grids) => {
      const out = [];
      for (const [status, id] of grids) {
        const root = document.getElementById(id);
        if (!root) continue;
        const found = root.querySelectorAll('.InspectionListRow');
        const elements = found.length ? found : root.querySelectorAll('tr');
        for (const el of elements) {
          const text = el.innerText || '';
          if (text.trim()) out.push({ status, text });
        }
      }
      return out;
    }, INSPECTION_GRIDS)
    .catch(() => []);

  const inspections = rows
    .map(({ text, status }) => parseInspectionRow(text, status))
    // A header row yields nothing useful; drop anything with no type at all.
    .filter((i) => i && i.type);

  return { inspections };
}

/** Pulls description + job value off a permit's detail page. */
async function fetchDetail(page, detailUrl, { withTabs = false } = {}) {
  await gotoWithRetry(page, detailUrl, { attempts: 2 });
  // textContent, not innerText: ACA renders "Additional Information" (which is
  // where Job Value lives) inside a collapsed panel, and innerText drops
  // anything not visible — which silently zeroed every valuation.
  const text = await page.evaluate(() => {
    const body = document.body.cloneNode(true);
    body.querySelectorAll('script, style').forEach((n) => n.remove());
    return body.textContent || '';
  }).catch(() => '');

  const detail = parseDetailText(text);
  if (!withTabs) return detail;

  // Only reached when a source opts in: these cost extra round trips.
  try {
    Object.assign(detail, await fetchFees(page), await fetchInspections(page));
  } catch (err) {
    detail.tabError = err.message;
  }
  return detail;
}

// Labels that can follow a construction-type value on a detail page. Anything
// missing here shows up as text run on to the end of the stored value.
const CONSTRUCTION_STOPS = [
  'Other Construction Type', 'Permit Expiration', 'Expiration', 'Jurisdiction:',
  'Insp Area', 'In Metro', 'Inside UGB', 'FILO', 'Application Information',
  'Parcel', 'Fees', 'Inspections', 'GENERAL',
];

/**
 * Accela renders empty values as "--". Treated as absent rather than stored as
 * a literal "--" that would show up in the UI as if it were data.
 */
function cleanValue(value) {
  const text = (value || '')
    .replace(/\s+/g, ' ')
    // Accela appends " *" to mark the primary parcel/owner; it isn't part of
    // the value and would otherwise be stored and displayed as if it were.
    .replace(/\s*\*\s*$/, '')
    .trim();
  if (!text || text === '--' || text === 'N/A') return null;
  return text;
}

/**
 * Pulls one "Label: value" field out of the detail page's flattened text,
 * stopping at whichever of the following labels appears first.
 *
 * Parsed by label rather than by element id because ACA generates per-record
 * ids (e.g. `..._label_project639246923794524284`) that are not stable.
 */
// These are all short fields — a name, a parcel number, a construction type.
// A value running on past this is a parse failure, not a long value: the label
// matched somewhere unintended and the capture ran to the end of the page.
// Returning null loses one field; storing the run-on pollutes the record and
// breaks the layout that displays it.
const MAX_FIELD_LENGTH = 200;

function labelledField(text, label, stops = []) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stopPattern = stops.length ? stops.map(escape).join('|') : null;

  // \b matters more than it looks: without it "Owner" matches inside
  // "Homeowners", which is how an Oregon ePermitting page's nav text
  // ("Homeowners Register for Oregon ePermitting Apply for...") ended up stored
  // as a permit's owner.
  const pattern = new RegExp(
    `\\b${escape(label)}\\s*:?\\s*([\\s\\S]*?)\\s*(?:${stopPattern ? `${stopPattern}|` : ''}$)`,
    'i',
  );
  const match = text.match(pattern);
  const value = match ? cleanValue(match[1]) : null;
  return value && value.length <= MAX_FIELD_LENGTH ? value : null;
}

/**
 * Detail pages render as label/value text. Everything below is read from the
 * page we ALREADY fetch for the description and job value, so these fields cost
 * no additional requests — they were simply being discarded before.
 */
function parseDetailText(text) {
  const flat = (text || '').replace(/\r/g, '');

  const desc = flat.match(/Project Description:\s*([\s\S]*?)\s*(?:Owner:|More Details|Additional Information|Job Value|$)/i);
  const value = flat.match(/Job Value\(\$\):\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);

  // "Owner: BERKA CHERU * 7300 SE SAN MARCOS AVE ... 1) Cheru Berka" — the name
  // comes first, followed by the owner's mailing address. Only the name is kept;
  // the address that follows is the OWNER's, not necessarily the job site's, and
  // conflating the two would be wrong.
  const ownerRaw = labelledField(flat, 'Owner', ['More Details', 'Additional Information', 'Job Value', 'Parcel']);
  const owner = ownerRaw ? cleanValue(ownerRaw.split('*')[0]) : null;

  return {
    projectDescription: desc ? desc[1].replace(/\s+/g, ' ').trim() : '',
    valuation: value ? Number(value[1].replace(/,/g, '')) : 0,
    owner,
    parcelNumber: labelledField(flat, 'Parcel Number', ['Block:', 'Lot:', 'Subdivision:']),
    parcelBlock: labelledField(flat, 'Block', ['Lot:', 'Subdivision:']),
    parcelLot: labelledField(flat, 'Lot', ['Subdivision:', 'Fees', 'Inspections']),
    parcelSubdivision: labelledField(flat, 'Subdivision', ['Fees', 'Inspections', 'Upcoming']),
    // Detail pages vary in which labels follow, so the stop list has to cover
    // every neighbour seen in live data — without 'Permit Expiration' this ran
    // on and stored "Addition/alteration... Permit Expiration: 03/2027".
    constructionType: labelledField(flat, 'Construction Type', CONSTRUCTION_STOPS),
    otherConstructionType: labelledField(flat, 'Other Construction Type', CONSTRUCTION_STOPS.filter((l) => l !== 'Other Construction Type')),
  };
}

/**
 * The human-readable description of the work. permitType is deliberately NOT
 * included — it has its own field now, and repeating it here would show up
 * twice in the UI. (Scoring still sees both: normalize.js `toScorable()`
 * recombines them, because Accela's controlled permit types are better trade
 * signal than its free-text descriptions.)
 *
 * Accela repeats itself — projectName is usually a prefix of
 * projectDescription ("- TEMP-PLUMB-SSA-88796" vs "- TEMP-PLUMB-SSA-88796 Add
 * new bathroom...") — so parts already contained in another part are dropped.
 */
function buildWorkDescription({ projectName, projectDescription, shortNotes }) {
  const parts = [projectName, projectDescription, shortNotes]
    .map((s) => (s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const kept = parts.filter(
    (part, i) => !parts.some((other, j) => j !== i && other.includes(part) && (other.length > part.length || j < i)),
  );
  return kept.join(' — ');
}

async function fetchAccelaSource(source, { includeIssued, daysBack = 30, maxRecords = 200, log, selectDetailTargets }) {
  const base = source.baseUrl.endsWith('/') ? source.baseUrl : `${source.baseUrl}/`;
  const module = source.module || 'Building';
  const delayMs = source.requestDelayMs ?? 1000;
  const wantDetails = source.fetchDetails !== false;

  const browser = await chromium.launch({ headless: true });
  const records = [];

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    });
    const page = await context.newPage();

    const url = `${base}Cap/CapHome.aspx?module=${module}&TabName=Home`;
    log.info(`Opening ${url}`);
    await gotoWithRetry(page, url, { log });

    const end = new Date();
    const start = new Date(end.getTime() - daysBack * 86400000);
    await page.waitForSelector(SEL.startDate, { timeout: 30000 });
    await typeDate(page, SEL.startDate, start);
    await typeDate(page, SEL.endDate, end);
    log.info(`Searching ${formatDate(start)} -> ${formatDate(end)}`);

    await page.click(SEL.search);
    try {
      await page.waitForSelector(SEL.grid, { timeout: 90000 });
    } catch (err) {
      // A rejected search re-renders the form with a validation summary rather
      // than the grid; report that instead of an opaque selector timeout.
      const body = await page.locator('body').innerText().catch(() => '');
      const errs = body.match(/\d+ error\(s\) occurred on current page\.[\s\S]{0,300}/);
      if (errs) throw new Error(`Accela rejected the search form: ${errs[0].replace(/\s+/g, ' ').slice(0, 220)}`);
      if (/no records? (were )?found/i.test(body)) {
        log.info('Accela reported no records for this date range.');
        return [];
      }
      throw err;
    }

    for (let pageNum = 1; records.length < maxRecords; pageNum += 1) {
      const rows = await extractGridPage(page);
      records.push(...rows);
      log.info(`  page ${pageNum}: ${rows.length} records (${records.length} total)`);
      if (rows.length === 0) break;

      await sleep(delayMs);
      if (records.length >= maxRecords) break;
      if (!(await gotoPage(page, pageNum + 1))) break;
    }

    records.length = Math.min(records.length, maxRecords);

    if (wantDetails && records.length > 0) {
      // A detail page costs one navigation plus a politeness delay per record,
      // so an incremental ingest passes a selector that drops permits it already
      // holds. It receives every grid record at once (so the caller can answer
      // with a single database query) and returns the subset worth fetching.
      // Grid rows stay cheap; only genuinely new permits pay the detail cost.
      const needed = selectDetailTargets ? await selectDetailTargets(records) : records;
      const skipped = records.length - needed.length;

      if (needed.length > 0) {
        log.info(
          `Fetching ${needed.length} detail pages for description + job value` +
            (skipped ? ` (skipping ${skipped} already known)` : '') + '...',
        );
        const detailPage = await context.newPage();
        for (const [i, rec] of needed.entries()) {
          try {
            Object.assign(rec, await fetchDetail(detailPage, rec.detailUrl, { withTabs: source.fetchTabs === true }));
          } catch (err) {
            log.warning(`  detail fetch failed for ${rec.permitNumber}: ${err.message}`);
          }
          if ((i + 1) % 25 === 0) log.info(`  ...${i + 1}/${needed.length}`);
          await sleep(delayMs);
        }
        await detailPage.close();
      } else if (skipped) {
        log.info(`All ${skipped} permits already known; no detail pages fetched.`);
      }
    }
  } finally {
    await browser.close();
  }

  return mapRecords(records, source, { includeIssued, log });
}

/** Pure record -> permit mapping, unit tested offline. */
function mapRecords(records, source, { includeIssued = true, log }) {
  const status = createStatusNormalizer({ statusMap: source.statusMap, label: source.label });

  const permits = records.map((rec) =>
    normalizePermit({
      address: rec.address,
      jurisdiction: rec.agency || source.jurisdiction || source.label,
      permitType: rec.permitType,
      workDescription: buildWorkDescription(rec),
      valuation: rec.valuation,
      status: status.normalize(rec.status),
      statusRaw: rec.status,
      permitUrl: rec.detailUrl,
      permitNumber: rec.permitNumber,
      filedDate: rec.filedDate,
      owner: rec.owner,
      parcelNumber: rec.parcelNumber,
      parcelBlock: rec.parcelBlock,
      parcelLot: rec.parcelLot,
      parcelSubdivision: rec.parcelSubdivision,
      constructionType: rec.constructionType,
      otherConstructionType: rec.otherConstructionType,
      fees: rec.fees,
      feesPaid: rec.feesPaid,
      feesBalance: rec.feesBalance,
      inspections: rec.inspections,
    }),
  );

  status.report(log);
  return includeIssued ? permits : permits.filter((p) => p.status !== 'issued');
}

module.exports = { fetchAccelaSource, mapRecords, buildWorkDescription, parseDetailText, cleanValue, fetchFees, fetchInspections, parseInspectionRow, SEL, HEADER_ALIASES };
