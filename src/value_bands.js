// Property values are shown as bands, never exact (ADR-23 decision 3,
// docs/DATA_ENGINE_PLAN.md section 12). The exact appraisal figure stays in the
// database; only the band leaves the server.

const EDGES = [100e3, 250e3, 500e3, 1e6, 2e6, 5e6, 10e6, 25e6];

const short = (n) => (n >= 1e6 ? `$${n / 1e6}M` : `$${n / 1e3}k`);

/** A dollar amount -> { label, low, high } (high null on the top band), or null. */
function valueBand(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  let low = 0;
  for (const edge of EDGES) {
    if (n < edge) return { label: low ? `${short(low)}-${short(edge)}` : `under ${short(edge)}`, low, high: edge };
    low = edge;
  }
  return { label: `${short(low)}+`, low, high: null };
}

module.exports = { valueBand, EDGES };
