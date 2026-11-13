// /api/pilot/*: the data behind the live pilot screens (web/public/pilot/live).
// Validation lives in db/pilot_queries.parseFilters; privacy and provenance
// rules are enforced in those queries, not here.

const express = require('express');
const pq = require('../db/pilot_queries.js');

const router = express.Router();

const route = (handler) => (req, res) => {
  Promise.resolve(handler(req, res)).catch((err) => {
    console.error(err);
    // No SQL or stack to the client.
    res.status(500).json({ error: 'Query failed' });
  });
};

const idParam = (v) => (/^\d{1,18}$/.test(String(v)) ? Number(v) : null);

router.get('/meta', route(async (req, res) => {
  const f = pq.parseFilters(req.query);
  res.json(await pq.sourceMeta(f.source));
}));

router.get('/gcs', route(async (req, res) => {
  const f = pq.parseFilters(req.query);
  const [gcs, baseline, meta] = await Promise.all([pq.listGcs(f), pq.marketBaseline(f), pq.sourceMeta(f.source)]);
  res.json({ filters: f, openWindowDays: pq.OPEN_WINDOW_DAYS, baseline, meta, gcs });
}));

router.get('/jobs/:id', route(async (req, res) => {
  const id = idParam(req.params.id);
  if (id == null) return res.status(400).json({ error: 'Bad permit id' });
  const job = await pq.getJob(id, pq.parseFilters(req.query));
  if (!job) return res.status(404).json({ error: 'Permit not found' });
  return res.json(job);
}));

router.get('/contractors/:id', route(async (req, res) => {
  const id = idParam(req.params.id);
  if (id == null) return res.status(400).json({ error: 'Bad contractor id' });
  const c = await pq.getContractor(id);
  if (!c) return res.status(404).json({ error: 'Contractor not found' });
  return res.json(c);
}));

router.get('/leads', route(async (req, res) => {
  const f = pq.parseFilters(req.query);
  const days = [7, 14, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
  const minValuation = /^\d{1,9}$/.test(String(req.query.minValuation || '')) ? Number(req.query.minValuation) : null;
  const [leads, meta] = await Promise.all([pq.listLeads(f, { days, minValuation }), pq.sourceMeta(f.source)]);
  res.json({ filters: f, days, minValuation, meta, leads });
}));

module.exports = { router };
