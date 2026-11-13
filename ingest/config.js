// Resolves which sources the scheduler and the manual ingest run, and how much
// each run may pull. Pure (reads only the env object it is given) so it can be
// tested without a database.
//
// Why this exists: the scheduler used to default to the two Oregon Accela
// sources only, so the pilot markets (Austin, Miami-Dade) went stale unless
// someone remembered to set INGEST_AREAS. And one global INGEST_MAX of 300 was
// below Austin's weekly volume (~158 permits/day), so a 7-day window silently
// dropped its oldest records.

const { SOURCES, PILOT_AREAS } = require('../src/sources.js');

const DEFAULTS = {
  intervalMinutes: 360,
  days: 7,
};

function parseAreas(value) {
  if (!value) return [...PILOT_AREAS];
  const areas = value.split(',').map((a) => a.trim()).filter(Boolean);
  const unknown = areas.filter((a) => !SOURCES[a]);
  if (unknown.length) {
    throw new Error(`Unknown area(s) in INGEST_AREAS: ${unknown.join(', ')}. Known: ${Object.keys(SOURCES).join(', ')}`);
  }
  return areas;
}

function positiveInt(value, name, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${value}"`);
  return n;
}

/**
 * Per-run record cap for one source. A source's own `maxPerRun` is a hard
 * ceiling (Miami-Dade's ArcGIS layer fails on very large pulls); INGEST_MAX can
 * only lower it.
 */
function maxFor(area, envMax) {
  const ceiling = SOURCES[area].maxPerRun;
  if (envMax === undefined) return ceiling;
  return Math.min(envMax, ceiling);
}

/** @param {Record<string, string|undefined>} env */
function resolveScheduleConfig(env = process.env) {
  const areas = parseAreas(env.INGEST_AREAS);
  const envMax = env.INGEST_MAX === undefined || env.INGEST_MAX === ''
    ? undefined
    : positiveInt(env.INGEST_MAX, 'INGEST_MAX');
  return {
    intervalMinutes: positiveInt(env.INGEST_INTERVAL_MINUTES, 'INGEST_INTERVAL_MINUTES', DEFAULTS.intervalMinutes),
    days: positiveInt(env.INGEST_DAYS, 'INGEST_DAYS', DEFAULTS.days),
    // Only an explicit INGEST_DAYS overrides a source's own syncWindows (ADR-11).
    daysExplicit: env.INGEST_DAYS !== undefined && env.INGEST_DAYS !== '',
    runs: areas.map((area) => ({ area, max: maxFor(area, envMax) })),
  };
}

module.exports = { resolveScheduleConfig, maxFor, DEFAULTS };
