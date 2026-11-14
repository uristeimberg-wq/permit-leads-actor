// /api/pilot/*: the data behind the live pilot screens (web/public/pilot/live).
// Validation lives in db/pilot_queries.parseFilters; privacy and provenance
// rules are enforced in those queries, not here.

const express = require('express');
const pq = require('../db/pilot_queries.js');
const { cache } = require('./cache.js');

const router = express.Router();

// Every route here is read-only and changes only with a sync, so each answer
// is served from the shared cache (web/cache.js), keyed by its URL.
const route = (compute) => cache.route(compute);

const idParam = (v) => (/^\d{1,18}$/.test(String(v)) ? Number(v) : null);

router.get('/meta', route(async (req) => pq.sourceMeta(pq.parseFilters(req.query).source)));

router.get('/gcs', route(async (req) => {
  const f = pq.parseFilters(req.query);
  const [gcs, baseline, meta] = await Promise.all([pq.listGcs(f), pq.marketBaseline(f), pq.sourceMeta(f.source)]);
  return { filters: f, openWindowDays: pq.OPEN_WINDOW_DAYS, baseline, meta, gcs };
}));

router.get('/jobs/:id', route(async (req) => {
  const id = idParam(req.params.id);
  if (id == null) return { status: 400, json: { error: 'Bad permit id' } };
  const job = await pq.getJob(id, pq.parseFilters(req.query));
  return job || { status: 404, json: { error: 'Permit not found' } };
}));

router.get('/contractors/:id', route(async (req) => {
  const id = idParam(req.params.id);
  if (id == null) return { status: 400, json: { error: 'Bad contractor id' } };
  const c = await pq.getContractor(id);
  return c || { status: 404, json: { error: 'Contractor not found' } };
}));

router.get('/leads', route(async (req) => {
  const f = pq.parseFilters(req.query);
  const days = [7, 14, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
  const minValuation = /^\d{1,9}$/.test(String(req.query.minValuation || '')) ? Number(req.query.minValuation) : null;
  const [leads, meta] = await Promise.all([pq.listLeads(f, { days, minValuation }), pq.sourceMeta(f.source)]);
  return { filters: f, days, minValuation, meta, leads };
}));

router.get('/early', route(async (req) => {
  const f = pq.parseFilters(req.query);
  const days = [7, 14, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const segment = ['homes', 'apartments', 'commercial'].includes(req.query.segment) ? req.query.segment : null;
  const [early, meta] = await Promise.all([pq.listEarly(f, { days, segment }), pq.sourceMeta(f.source)]);
  const sources = await Promise.all((meta && meta.earlySources || []).map((s) => pq.sourceMeta(s)));
  return { filters: f, days, stages: pq.EARLY_STAGES, meta, sources: sources.filter(Boolean), ...early };
}));

router.get('/momentum', route(async (req) => {
  const f = pq.parseFilters(req.query);
  const segment = ['homes', 'apartments', 'commercial'].includes(req.query.segment) ? req.query.segment : null;
  const windowDays = [60, 90, 180].includes(Number(req.query.window)) ? Number(req.query.window) : 90;
  return { filters: f, ...(await pq.listMomentum(f, { windowDays, segment })) };
}));

module.exports = { router };
