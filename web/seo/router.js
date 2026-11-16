// Public, indexable pages for search engines and AI answer engines (ADR-42):
//   /markets, /markets/<state>/<city>, /data-methodology,
//   /robots.txt, /sitemap.xml, /llms.txt, /llms-full.txt
//
// Mounted before the access gate and before the app's blanket noindex
// header (web/server.js), because these pages carry counts only: no record,
// contractor, owner or phone (web/seo/render.js). The app itself keeps
// `X-Robots-Tag: noindex, nofollow`.
//
// Server-rendered: a crawler gets the whole page, structured data included,
// in the first response. The aggregates are kept in memory (fresh 10
// minutes, then served stale while recomputed, up to 36 hours) because the
// data changes once a day; each page states its own last sync, so a stale
// copy never claims freshness it does not have (hard rule 7).
//
// Canonical links point at PUBLIC_BASE_URL (default https://giboro.com). The
// same pages on the railway.app address, or a local run, send noindex so
// search engines do not hold two copies. Mirrors are named rather than
// "anything but the canonical host", so a Host header we did not expect on
// giboro.com can never silently de-index the real site.

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const express = require('express');
const { MARKETS, findMarket, marketPath } = require('./markets.js');
const render = require('./render.js');
const { crawlerOf } = require('../referrer_channels.js');

const DEFAULT_BASE = 'https://giboro.com';
// Set when the app's page is served (web/server.js): this browser has used the app.
const APP_COOKIE = 'ct_app';
const hasAppCookie = (req) => String(req.get('cookie') || '').split(';').some((c) => c.trim() === `${APP_COOKIE}=1`);
const isMirrorHost = (hostname) => /(^|\.)(railway\.app|localhost)$|^127\.|^\[?::1\]?$/i.test(String(hostname || ''));
const baseUrl = (env = process.env) => String(env.PUBLIC_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');

/** A small stale-while-revalidate memo for the aggregates. */
function memo({ freshMs = 10 * 60 * 1000, staleMs = 36 * 3600 * 1000, enabled = process.env.API_CACHE !== 'off', now = () => Date.now(), log = (m) => console.error(m) } = {}) {
  const entries = new Map();
  const pending = new Map();
  const refresh = (key, fn) => {
    if (pending.has(key)) return pending.get(key);
    const p = Promise.resolve().then(fn).then((value) => {
      if (enabled) entries.set(key, { at: now(), value });
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  };
  return {
    async get(key, fn) {
      const e = enabled ? entries.get(key) : null;
      const age = e ? now() - e.at : Infinity;
      if (e && age < freshMs) return e.value;
      if (e && age < staleMs) {
        refresh(key, fn).catch((err) => log(`seo: background refresh of ${key} failed: ${err.message}`));
        return e.value;
      }
      return refresh(key, fn);
    },
    warm(list) { return Promise.all(list.map(([key, fn]) => refresh(key, fn).catch((err) => log(`seo: warm-up of ${key} failed: ${err.message}`)))); },
    clear: () => entries.clear(),
  };
}

/**
 * @param {object} deps
 * @param {(market) => Promise<object>} deps.marketStats   db/seo_queries.js marketStats
 * @param {() => Promise<object[]>} deps.allSources          db/seo_queries.js allPermitSources
 * @param {(visit) => Promise<void>} [deps.recordCrawl]       counts a crawler's visit (db, best effort)
 * @param {object} [deps.env]
 */
function router({ marketStats, allSources, recordCrawl = null, env = process.env, cache = memo() }) {
  const r = express.Router({ caseSensitive: false, strict: false });
  const base = () => baseUrl(env);

  const statsFor = (m) => cache.get(`market:${m.state}/${m.city}`, () => marketStats(m));
  const sourcesList = () => cache.get('sources', () => allSources());
  /** Publishable markets with their stats; a market whose query fails is left out and logged. */
  async function publishable() {
    const out = await Promise.all(MARKETS.map(async (market) => {
      try { return { market, stats: await statsFor(market) }; } catch (err) { console.error(`seo: ${market.city} failed: ${err.message}`); return null; }
    }));
    return out.filter((x) => x && render.isPublishable(x.stats));
  }

  // Headers every public response carries, and a crawler count.
  r.use((req, res, next) => {
    if (isMirrorHost(req.hostname)) res.set('X-Robots-Tag', 'noindex, follow');
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    if (recordCrawl) {
      const crawler = crawlerOf(req.get('user-agent'));
      // The route's pattern, never the raw URL, so the table cannot grow without bound.
      if (crawler) res.on('finish', () => {
        const path = req.seoRoute;
        if (path) Promise.resolve(recordCrawl({ crawler, path, status: res.statusCode })).catch((e) => console.error(`seo: crawl count failed: ${e.message}`));
      });
    }
    next();
  });

  /** Sends a body with an ETag (304 on a match) and gzip when accepted. */
  function send(req, res, type, body, status = 200) {
    const buf = Buffer.from(body);
    const etag = `"${crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 27)}"`;
    res.set('ETag', etag);
    if (!res.get('Vary')) res.set('Vary', 'Accept-Encoding');
    res.type(type);
    if (status === 200 && req.get('if-none-match') === etag) return res.status(304).end();
    res.status(status);
    if (buf.length > 1024 && /\bgzip\b/.test(req.get('accept-encoding') || '')) {
      res.set('Content-Encoding', 'gzip');
      return res.send(zlib.gzipSync(buf, { level: 6 }));
    }
    return res.send(buf);
  }

  const notFound = (req, res) => {
    res.set('X-Robots-Tag', 'noindex');
    res.set('Cache-Control', 'public, max-age=300');
    return send(req, res, 'html', render.layout({
      title: 'Page not found', description: 'This market is not covered.', path: req.path, base: base(),
    }, `<h1>Not covered</h1><p>We have no page for this place. These markets are covered: ${MARKETS.map((m) => `<a href="${render.esc(marketPath(m))}">${render.esc(m.name)}</a>`).join(', ')}.</p>`), 404);
  };
  const unavailable = (req, res, err) => {
    console.error(err);
    res.set('Retry-After', '300');
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    return res.status(503).type('text').send('Temporarily unavailable. Try again in a few minutes.');
  };
  const tag = (route) => (req, _res, next) => { req.seoRoute = route; next(); };

  // The home page, for a visitor who has never opened the app (and for
  // crawlers, which carry no cookie). Anyone who has opened the app gets the
  // app at / as before (APP_COOKIE, set by web/server.js), and so does any
  // link with a query string (/?areas=a:TX, old shared searches).
  r.get('/', (req, res, next) => {
    res.set('Vary', 'Accept-Encoding, Cookie');
    if (Object.keys(req.query || {}).length || hasAppCookie(req)) return next();
    req.seoRoute = '/';
    return publishable().then((list) => {
      res.set('Cache-Control', 'no-cache');
      return send(req, res, 'html', render.homePage(list, base()));
    }, (err) => unavailable(req, res, err));
  });

  r.get('/markets', tag('/markets'), async (req, res) => {
    try { return send(req, res, 'html', render.marketsIndex(await publishable(), base())); } catch (err) { return unavailable(req, res, err); }
  });

  r.get('/markets/:state/:city', tag('/markets/:state/:city'), async (req, res) => {
    const m = findMarket(req.params.state, req.params.city);
    if (!m) return notFound(req, res);
    const path = marketPath(m);
    // One address per page: /markets/TX/Austin/ goes to /markets/tx/austin.
    if (req.path !== path) return res.redirect(301, path);
    req.seoRoute = path;
    let stats;
    try { stats = await statsFor(m); } catch (err) { return unavailable(req, res, err); }
    if (!render.isPublishable(stats)) return notFound(req, res);
    return send(req, res, 'html', render.marketPage(m, stats, base()));
  });

  r.get('/data-methodology', tag('/data-methodology'), async (req, res) => {
    try { return send(req, res, 'html', render.methodologyPage(await sourcesList(), base())); } catch (err) { return unavailable(req, res, err); }
  });

  r.get('/robots.txt', tag('/robots.txt'), (req, res) => send(req, res, 'text/plain; charset=utf-8', render.robotsTxt(base())));

  r.get('/sitemap.xml', tag('/sitemap.xml'), async (req, res) => {
    try {
      const list = await publishable();
      const newest = list.map((x) => x.stats.lastSyncAt).filter(Boolean).sort().pop() || null;
      const urls = [
        { path: '/', lastmod: newest },
        { path: '/markets', lastmod: newest },
        ...list.map(({ market, stats }) => ({ path: marketPath(market), lastmod: stats.lastSyncAt })),
        { path: '/data-methodology', lastmod: newest },
      ];
      return send(req, res, 'application/xml; charset=utf-8', render.sitemapXml(base(), urls));
    } catch (err) { return unavailable(req, res, err); }
  });

  for (const [path, full] of [['/llms.txt', false], ['/llms-full.txt', true]]) {
    r.get(path, tag(path), async (req, res) => {
      try { return send(req, res, 'text/markdown; charset=utf-8', render.llmsTxt(base(), await publishable(), { full })); } catch (err) { return unavailable(req, res, err); }
    });
  }

  r.warm = () => cache.warm([...MARKETS.map((m) => [`market:${m.state}/${m.city}`, () => marketStats(m)]), ['sources', () => allSources()]]);
  return r;
}

/** Counts a crawler visit per UTC day, crawler and route (migration 042). */
const pgCrawlRecorder = (query) => ({ crawler, path, status }) => query(`
  INSERT INTO crawler_visits (day, crawler, path, status_class, hits)
  VALUES ((now() AT TIME ZONE 'UTC')::date, $1, $2, $3, 1)
  ON CONFLICT (day, crawler, path, status_class) DO UPDATE SET hits = crawler_visits.hits + 1, last_at = now()`,
[crawler, path, `${Math.floor(status / 100)}xx`]);

module.exports = { router, memo, baseUrl, isMirrorHost, hasAppCookie, APP_COOKIE, pgCrawlRecorder, DEFAULT_BASE };
