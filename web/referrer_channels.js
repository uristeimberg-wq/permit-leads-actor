// Where a visit came from, in five channels, and which crawler a request
// claims to be (ADR-42). Shared by the analytics dashboard's SQL
// (web/admin_charts.js) and the public pages' crawler count (web/seo/router.js).
//
// Input is what analytics_sessions already stores: the referring site's host
// (never its path or query) and the UTM source. ChatGPT adds
// utm_source=chatgpt.com to the links it cites; Google, Bing and Perplexity
// send their host as the referrer. A channel is a reading of those two
// fields, nothing more: a search engine that sends no referrer is "direct".
//
// Crawler names come from the User-Agent header, which anyone can set, so the
// dashboard calls them "claimed". Verifying by reverse DNS is not done.

// Checked first: gemini.google.com must not read as Google search.
const AI_HOSTS = [
  'chatgpt.com', 'chat.openai.com', 'openai.com', 'perplexity.ai', 'claude.ai', 'gemini.google.com', 'bard.google.com',
  'copilot.microsoft.com', 'you.com', 'phind.com', 'poe.com', 'meta.ai', 'chat.deepseek.com', 'grok.com', 'chat.mistral.ai',
];
// Search engines, matched on the host's name in any country domain.
const SEARCH_NAMES = ['google', 'bing', 'duckduckgo', 'yahoo', 'ecosia', 'yandex', 'baidu', 'startpage', 'qwant', 'naver', 'seznam'];
const SEARCH_HOSTS = ['search.brave.com'];

const CHANNELS = ['ai', 'search', 'campaign', 'referral', 'direct'];
const CHANNEL_LABELS = { ai: 'AI assistants', search: 'Search engines', campaign: 'Campaign links (UTM)', referral: 'Other sites', direct: 'Direct or unknown' };

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Host is the value or a subdomain of it: www.perplexity.ai, chatgpt.com.
const AI_RE = `(^|\\.)(${AI_HOSTS.map(escRe).join('|')})$`;
// www.google.com, google.co.uk, search.yahoo.com, m.bing.com; not docs.google.com
// or google.example.com.
const TLD = '(com|org|net|[a-z]{2}|co\\.[a-z]{2}|com\\.[a-z]{2})';
const SEARCH_RE = `^((www|search|m)\\.)?(${SEARCH_NAMES.join('|')})\\.${TLD}$|^(${SEARCH_HOSTS.map(escRe).join('|')})$`;
// A UTM source naming an AI assistant ("chatgpt.com", "perplexity", "claude").
const AI_UTM_RE = '(chatgpt|openai|perplexity|claude|gemini|copilot|deepseek|grok|mistral)';
const SEARCH_UTM_RE = `^(${SEARCH_NAMES.join('|')})(\\.|$)`;

const host = (v) => String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:?#].*$/, '');

/** One of CHANNELS for a session's { referrer, utm_source }. */
function channelOf({ referrer, utm_source: utm } = {}) {
  const ref = host(referrer);
  const u = String(utm || '').trim().toLowerCase();
  if ((ref && new RegExp(AI_RE).test(ref)) || (u && new RegExp(AI_UTM_RE).test(u))) return 'ai';
  if ((ref && new RegExp(SEARCH_RE).test(ref)) || (u && new RegExp(SEARCH_UTM_RE).test(u))) return 'search';
  if (u) return 'campaign';
  if (ref) return 'referral';
  return 'direct';
}

/** The same classification in SQL over two column expressions. The patterns are constants, never input. */
function channelSql(refCol = 'referrer', utmCol = 'utm_source') {
  const lit = (s) => { if (s.includes("'")) throw new Error('quote in pattern'); return `'${s}'`; };
  const r = `lower(coalesce(${refCol}, ''))`;
  const u = `lower(coalesce(${utmCol}, ''))`;
  return `CASE
    WHEN ${r} ~ ${lit(AI_RE)} OR (${u} <> '' AND ${u} ~ ${lit(AI_UTM_RE)}) THEN 'ai'
    WHEN ${r} ~ ${lit(SEARCH_RE)} OR (${u} <> '' AND ${u} ~ ${lit(SEARCH_UTM_RE)}) THEN 'search'
    WHEN ${u} <> '' THEN 'campaign'
    WHEN ${r} <> '' THEN 'referral'
    ELSE 'direct' END`;
}

// [token in the User-Agent, name we store]. Order matters: the first match wins.
const CRAWLERS = [
  ['oai-searchbot', 'OAI-SearchBot'], ['chatgpt-user', 'ChatGPT-User'], ['gptbot', 'GPTBot'],
  ['perplexity-user', 'Perplexity-User'], ['perplexitybot', 'PerplexityBot'],
  ['claude-searchbot', 'Claude-SearchBot'], ['claude-user', 'Claude-User'], ['claudebot', 'ClaudeBot'], ['claude-web', 'Claude-Web'], ['anthropic-ai', 'anthropic-ai'],
  ['google-inspectiontool', 'Google-InspectionTool'], ['googleother', 'GoogleOther'], ['googlebot', 'Googlebot'],
  ['bingbot', 'Bingbot'], ['applebot', 'Applebot'], ['duckduckbot', 'DuckDuckBot'], ['yandexbot', 'YandexBot'], ['baiduspider', 'Baiduspider'],
  ['amazonbot', 'Amazonbot'], ['meta-externalagent', 'Meta-ExternalAgent'], ['ccbot', 'CCBot'], ['bytespider', 'Bytespider'],
];

/** The crawler a User-Agent claims to be, or null. */
function crawlerOf(ua) {
  const s = String(ua || '').toLowerCase();
  if (!s) return null;
  const hit = CRAWLERS.find(([token]) => s.includes(token));
  return hit ? hit[1] : null;
}

module.exports = { channelOf, channelSql, crawlerOf, CHANNELS, CHANNEL_LABELS, AI_HOSTS, SEARCH_NAMES, CRAWLERS };
