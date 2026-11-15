// Per-source, per-window watermarks (migration 035, source_watermarks).
//
// A sync reads overlapping look-back windows (ADR-11): new filings by their
// filed or issued date, changes by a status or update date. A fixed window
// misses whatever happened while the sync was down for longer than the
// window. The watermark is the start of the last run that succeeded without
// truncation; a window is widened to reach back past it, plus a day of
// overlap, so a missed week is read on the next run. Upserts make the
// overlap free of duplicates.
//
// Not a modified-since cursor on purpose: Austin's :updated_at moves for
// every row daily (the publisher reloads the dataset), so it would be a full
// rescan. Widening is capped; a gap beyond the cap is recorded as a
// 'watermark_gap' error event and needs a backfill (--kind=backfill --days=N).
//
// A truncated run does not advance the watermark: the cap dropped the oldest
// rows of a window, so the next run must look back over them again.

const DAY_MS = 86400000;
const OVERLAP_DAYS = 1;
const MAX_CATCHUP_DAYS = 120;

/**
 * @param {{field: string, days: number, layer?: number}[]} windows the source's windows
 * @param {Map<string, Date>|Object<string, Date>} marks last_successful_sync_at by window field
 * @param {{now?: Date, fallback?: Date|null, maxCatchupDays?: number}} [opts]
 *   fallback: the source's last successful sync, for a window with no watermark yet
 * @returns {{windows: object[], widened: object[], gaps: object[]}}
 */
function effectiveWindows(windows, marks, { now = new Date(), fallback = null, maxCatchupDays = MAX_CATCHUP_DAYS } = {}) {
  const get = (f) => (marks instanceof Map ? marks.get(f) : marks && marks[f]) || fallback || null;
  const widened = [];
  const gaps = [];
  const out = windows.map((w) => {
    const mark = get(w.field);
    if (!mark) return { ...w };
    const since = Math.ceil((now.getTime() - new Date(mark).getTime()) / DAY_MS) + OVERLAP_DAYS;
    if (since <= w.days) return { ...w };
    const days = Math.min(since, maxCatchupDays);
    widened.push({ field: w.field, layer: w.layer, from: w.days, to: days, lastSuccess: new Date(mark).toISOString() });
    if (since > maxCatchupDays) gaps.push({ field: w.field, layer: w.layer, uncoveredDays: since - maxCatchupDays, lastSuccess: new Date(mark).toISOString() });
    return { ...w, days };
  });
  return { windows: out, widened, gaps };
}

/**
 * Newest value of each window field in the raw rows, as an ISO timestamp:
 * the source's own date, kept to report how far its data reaches.
 */
function highWaterValues(rows, windows) {
  const out = {};
  for (const { field } of windows) {
    let max = null;
    for (const row of rows) {
      const v = row && row[field];
      if (v == null || v === '') continue;
      const t = typeof v === 'number' ? v : Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? v : `${String(v).slice(0, 19)}Z`);
      // A date in the future is a data-entry error, not a watermark.
      if (Number.isFinite(t) && Math.abs(t) <= 8.64e15 && t <= Date.now() + DAY_MS && (max == null || t > max)) max = t;
    }
    if (max != null) out[field] = new Date(max).toISOString();
  }
  return out;
}

module.exports = { effectiveWindows, highWaterValues, OVERLAP_DAYS, MAX_CATCHUP_DAYS };
