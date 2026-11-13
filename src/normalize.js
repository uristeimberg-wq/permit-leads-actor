// Every adapter pulls from a different kind of portal (CSV export, ArcGIS REST,
// a browser-driven Accela portal), but everything downstream — scoring, tiering,
// dataset output — expects one shape. That contract lives here.

const { parseAddress } = require('./address.js');
const { toIsoDate } = require('./dates.js');
const { stageFor } = require('./status.js');

// The only two statuses scoring.js awards a timing bonus for. Anything else
// silently earns +0, which is why unmapped values are reported loudly below.
const KNOWN_STATUSES = new Set(['applied', 'issued']);

/**
 * Translates a source's own status vocabulary into the `applied`/`issued`
 * values TIMING_BONUS understands, and keeps track of anything it couldn't
 * translate so the run can warn once instead of per row.
 *
 * @param {{statusMap?: Record<string,string>, label?: string}} options
 */
function createStatusNormalizer({ statusMap = null, label = 'source' } = {}) {
  const unmapped = new Map();

  function normalize(rawStatus) {
    // `??` rather than `||`: a present-but-empty status stays empty and earns
    // no bonus, matching the original main.js behavior. Only a missing status
    // defaults to 'applied'.
    const key = String(rawStatus ?? 'applied').trim().toLowerCase();

    if (statusMap) {
      const mapped = statusMap[key];
      if (mapped) return mapped;
    }
    if (KNOWN_STATUSES.has(key)) return key;

    unmapped.set(key, (unmapped.get(key) ?? 0) + 1);
    return key;
  }

  /** Report unmapped statuses once, after all rows are normalized. */
  function report(log) {
    if (unmapped.size === 0) return;
    const detail = [...unmapped.entries()]
      .map(([status, count]) => `"${status}" x${count}`)
      .join(', ');
    log.warning(
      `[${label}] ${unmapped.size} unmapped status value(s): ${detail}. ` +
        `These earn no timing bonus — add them to this source's statusMap.`,
    );
  }

  return { normalize, report, unmapped };
}

/**
 * Phone numbers arrive unformatted (Austin stores "5128737333"). Kept as digits
 * so they compare and de-duplicate reliably; formatting is a display concern.
 * Returns null for anything that isn't a plausible US number, rather than
 * storing a fragment that looks like a phone but can't be dialled.
 */
function normalizePhone(value) {
  if (value == null) return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits.length === 10 ? digits : null;
}

/**
 * Coerces an adapter's extracted fields into the canonical permit shape —
 * what scorePermit() consumes AND what the database stores.
 *
 * Place fields are derived here rather than in each adapter so every source
 * gets identical parsing, and `filedDate` is normalized to a plain ISO date so
 * permits from different portals can be sorted and range-filtered together.
 */
function normalizePermit(fields) {
  const place = parseAddress(fields.address);

  const clean = (v) => {
    const text = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
    return text || null;
  };

  return {
    // Raw address is kept for display; the parsed parts are what we filter on.
    address: fields.address ?? null,
    street: place.street,
    // Open-data sources publish city/state/zip as their own columns, which is
    // more reliable than parsing them back out of a concatenated string — so an
    // explicitly supplied value always wins over the parsed one.
    city: clean(fields.city)?.toUpperCase() ?? place.city,
    state: clean(fields.state)?.toUpperCase() ?? place.state,
    zip: clean(fields.zip)?.slice(0, 5) ?? place.zip,
    // Which agency issued it. Statewide feeds cover many jurisdictions, so this
    // is the difference between "Oregon" and an actual county the user can pick.
    jurisdiction: fields.jurisdiction ?? null,
    // Kept separate from workDescription so the UI can facet on it.
    permitType: fields.permitType ?? null,
    workDescription: fields.workDescription ?? '',
    valuation: Number(fields.valuation) || 0,

    // Three status values, each with a distinct job:
    //   status      — the applied/issued bucket scoring's TIMING_BONUS reads
    //   statusRaw   — the portal's exact wording, shown to the user as-is
    //   statusStage — the lifecycle stage users filter on, so a FINISHED job is
    //                 never confused with one that was just approved
    status: fields.status,
    statusRaw: fields.statusRaw ?? null,
    // A source may supply the stage directly when its layer publishes no status
    // wording at all and the stage has to be derived from other columns.
    statusStage: fields.statusStage ?? stageFor(fields.statusRaw),

    permitUrl: fields.permitUrl ?? null,
    permitNumber: fields.permitNumber ?? null,
    filedDate: toIsoDate(fields.filedDate),

    // Detail-page fields. These come from the page already fetched for the
    // description, so they cost nothing extra — the point is that a user can
    // read a permit in full without leaving for the county portal.
    owner: fields.owner ?? null,
    parcelNumber: fields.parcelNumber ?? null,
    parcelBlock: fields.parcelBlock ?? null,
    parcelLot: fields.parcelLot ?? null,
    parcelSubdivision: fields.parcelSubdivision ?? null,
    constructionType: fields.constructionType ?? null,
    otherConstructionType: fields.otherConstructionType ?? null,

    // Contractor contact. Availability differs sharply by market: Austin's open
    // data publishes the phone outright, Miami-Dade gives a name and licence
    // number but no phone, and the Oregon portals publish neither.
    contractorName: clean(fields.contractorName),
    contractorPhone: normalizePhone(fields.contractorPhone),
    contractorLicence: clean(fields.contractorLicence),
    contractorTrade: clean(fields.contractorTrade),
    contractorCity: clean(fields.contractorCity)?.toUpperCase() ?? null,
    applicantName: clean(fields.applicantName),
    applicantPhone: normalizePhone(fields.applicantPhone),

    // Only populated for sources with fetchTabs enabled — these come from
    // lazily-loaded tabs and cost extra requests per permit.
    fees: fields.fees ?? null,
    feesPaid: fields.feesPaid ?? null,
    feesBalance: fields.feesBalance ?? null,
    inspections: fields.inspections ?? null,
  };
}

/**
 * Scoring reads a single `workDescription`, but the permit type is often the
 * stronger trade signal — "Building - Residential New" says more than the
 * free-text note beside it. This recombines them for scoring only, leaving the
 * stored record clean.
 */
function toScorable(permit) {
  const text = [permit.permitType, permit.workDescription]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(' — ');
  return { ...permit, workDescription: text };
}

module.exports = { createStatusNormalizer, normalizePermit, toScorable, normalizePhone, KNOWN_STATUSES };
