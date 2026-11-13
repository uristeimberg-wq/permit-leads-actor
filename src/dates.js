// Date normalization. Adapters receive dates in whatever shape their portal
// uses — Accela renders MM/DD/YYYY text, ArcGIS returns epoch milliseconds that
// arcgis.js already converts to ISO, and some sources have no date at all.
//
// Everything is normalized to a plain ISO date string (YYYY-MM-DD) so permits
// can be sorted by recency and filtered by range. No time, no timezone: a
// permit's filing date is a calendar date, and attaching a timezone to it only
// creates off-by-one-day bugs.

const ISO = /^(\d{4})-(\d{2})-(\d{2})/;
const US = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function isRealDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Round-trip check rejects impossible dates like 02/30 that Date would
  // otherwise silently roll forward into March.
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * @param {string|Date|number|null|undefined} value
 * @returns {string|null} YYYY-MM-DD, or null if it isn't a usable date
 */
function toIsoDate(value) {
  if (value == null || value === '') return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }

  // Epoch milliseconds, as ArcGIS date fields arrive before mapping.
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return new Date(value).toISOString().slice(0, 10);
  }

  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  const iso = text.match(ISO);
  if (iso) {
    const [, y, m, d] = iso.map(Number);
    return isRealDate(y, m, d) ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
  }

  const us = text.match(US);
  if (us) {
    const month = Number(us[1]);
    const day = Number(us[2]);
    const year = Number(us[3]);
    return isRealDate(year, month, day) ? `${year}-${pad(month)}-${pad(day)}` : null;
  }

  return null;
}

module.exports = { toIsoDate };
