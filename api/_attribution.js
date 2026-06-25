// ============================================================
//  Shared attribution helpers
//  Used by submit-enquiry / submit-stayluxe / track / dashboard
// ============================================================
//
//  Session model in Vercel KV:
//    key:    session:<sl_session_id>
//    ttl:    90 days (matches Google Ads click window)
//    value:  {
//      first:   { ts, gclid, gbraid, wbraid, campaign, adgroup,
//                 term, matchtype, referrer, landing, utm_source,
//                 utm_medium, ip, country, region, city,
//                 device, browser, os, userAgent },
//      last:    { ...same shape, overwritten each touch },
//      touches: [{ ts, path, campaign, referrer, source }, ...]  (cap 50)
//    }
// ============================================================

const UAParser = require('ua-parser-js');

const TOUCH_CAP   = 50;
const SESSION_TTL = 60 * 60 * 24 * 90;   // 90 days, seconds

// ──────────────────────────────────────────────────────────────
//  COOKIE PARSING — Squarespace sets sl_* cookies on every visit
// ──────────────────────────────────────────────────────────────
function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = decodeURIComponent(part.slice(i + 1).trim());
    if (k) out[k] = v;
  });
  return out;
}

// ──────────────────────────────────────────────────────────────
//  REQUEST → SESSION METADATA
//  Pulls from cookies, headers, body. Body wins if present
//  (Squarespace JS reads cookies into hidden inputs on submit).
// ──────────────────────────────────────────────────────────────
function buildTouch(req, bodyOverrides = {}) {
  const cookies = parseCookies(req);
  const b       = bodyOverrides || {};
  const h       = req.headers || {};

  const userAgent = h['user-agent'] || '';
  const ua        = userAgent ? new UAParser(userAgent).getResult() : {};

  const ip =
    (h['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress || '';

  const pick = (...vals) => vals.find(v => v != null && v !== '') || '';

  return {
    ts:         new Date().toISOString(),
    gclid:      pick(b.gclid,        cookies.sl_gclid),
    gbraid:     pick(b.gbraid,       cookies.sl_gbraid),
    wbraid:     pick(b.wbraid,       cookies.sl_wbraid),
    fbclid:     pick(b.fbclid,       cookies.sl_fbclid),
    campaign:   pick(b.utm_campaign, cookies.sl_campaign),
    adgroup:    pick(b.utm_adgroup,  cookies.sl_adgroup),
    term:       pick(b.utm_term,     cookies.sl_term),
    matchtype:  pick(b.utm_matchtype,cookies.sl_matchtype),
    utm_source: pick(b.utm_source,   cookies.sl_utm_source),
    utm_medium: pick(b.utm_medium,   cookies.sl_utm_medium),
    referrer:   pick(b.referrer,     cookies.sl_referrer,  h.referer),
    landing:    pick(b.landing_page, cookies.sl_landing_page),
    path:       pick(b.path,         ''),
    ip,
    country:    pick(h['x-vercel-ip-country'],     ''),
    region:     pick(h['x-vercel-ip-country-region'], ''),
    city:       pick(decodeURIComponent(h['x-vercel-ip-city'] || ''), ''),
    device:     ua.device?.type   || 'desktop',
    browser:    ua.browser?.name  || '',
    os:         ua.os?.name       || '',
    userAgent
  };
}

// ──────────────────────────────────────────────────────────────
//  CLASSIFY SESSION SOURCE — for the "Channel" column in dashboard
// ──────────────────────────────────────────────────────────────
function classifyTouch(t) {
  if (t.gclid || t.gbraid || t.wbraid) return 'Google Ads';
  if (t.fbclid)                        return 'Meta Ads';
  const src = (t.utm_source || '').toLowerCase();
  if (src) {
    if (/google/.test(src))   return 'Google Organic';
    if (/bing/.test(src))     return 'Bing';
    if (/facebook|fb/.test(src)) return 'Meta';
    if (/instagram|ig/.test(src)) return 'Instagram';
    if (/tiktok/.test(src))   return 'TikTok';
    if (/perplexity/.test(src)) return 'Perplexity';
    if (/chatgpt|openai/.test(src)) return 'ChatGPT';
    return src.charAt(0).toUpperCase() + src.slice(1);
  }
  const ref = (t.referrer || '').toLowerCase();
  if (!ref) return 'Direct';
  if (/google\./.test(ref))    return 'Google Organic';
  if (/bing\./.test(ref))      return 'Bing';
  if (/facebook|fb\./.test(ref)) return 'Meta';
  if (/instagram\./.test(ref)) return 'Instagram';
  if (/tiktok\./.test(ref))    return 'TikTok';
  if (/perplexity\./.test(ref)) return 'Perplexity';
  if (/chatgpt|openai/.test(ref)) return 'ChatGPT';
  return 'Referral';
}

// ──────────────────────────────────────────────────────────────
//  KV — get / upsert session
//  Lazy-imports @vercel/kv so handlers that don't touch KV stay clean
// ──────────────────────────────────────────────────────────────
let _kv = null;
async function kv() {
  if (_kv) return _kv;
  const { Redis } = await import('@upstash/redis');
  // Reads KV_REST_API_URL + KV_REST_API_TOKEN automatically from env.
  // Falls back to UPSTASH_REDIS_REST_URL / _TOKEN if you renamed them.
  _kv = Redis.fromEnv();
  return _kv;
}

async function getSession(sessionId) {
  if (!sessionId) return null;
  try {
    const k = await kv();
    return await k.get('session:' + sessionId);
  } catch (err) {
    console.warn('KV get failed (non-fatal):', err.message);
    return null;
  }
}

async function upsertTouch(sessionId, touch) {
  if (!sessionId) return null;
  try {
    const k       = await kv();
    const key     = 'session:' + sessionId;
    const current = (await k.get(key)) || { first: null, last: null, touches: [] };

    if (!current.first) current.first = touch;
    current.last    = touch;
    current.touches = [...(current.touches || []), {
      ts: touch.ts, path: touch.path, campaign: touch.campaign,
      referrer: touch.referrer, source: classifyTouch(touch)
    }].slice(-TOUCH_CAP);

    await k.set(key, current, { ex: SESSION_TTL });
    return current;
  } catch (err) {
    console.warn('KV upsert failed (non-fatal):', err.message);
    return null;
  }
}

async function attachSubmission(sessionId, leadMeta) {
  if (!sessionId) return null;
  try {
    const k   = await kv();
    const key = 'session:' + sessionId;
    const current = (await k.get(key)) || { first: null, last: null, touches: [] };
    current.submission = leadMeta;
    await k.set(key, current, { ex: SESSION_TTL });

    // Reverse-index by Monday item ID + email so the dashboard can join
    // a Monday lead back to its full attribution record cheaply.
    if (leadMeta?.mondayId) {
      await k.set('lookup:monday:' + leadMeta.mondayId, sessionId, { ex: SESSION_TTL });
    }
    if (leadMeta?.email) {
      const norm = String(leadMeta.email).toLowerCase().trim();
      await k.set('lookup:email:' + norm, sessionId, { ex: SESSION_TTL });
    }
    return current;
  } catch (err) {
    console.warn('KV submission attach failed (non-fatal):', err.message);
    return null;
  }
}

async function findSessionByMondayId(mondayId) {
  if (!mondayId) return null;
  try {
    const k   = await kv();
    const sid = await k.get('lookup:monday:' + mondayId);
    if (!sid) return null;
    return await k.get('session:' + sid);
  } catch (err) {
    console.warn('KV monday lookup failed:', err.message);
    return null;
  }
}

async function findSessionByEmail(email) {
  if (!email) return null;
  try {
    const k    = await kv();
    const norm = String(email).toLowerCase().trim();
    const sid  = await k.get('lookup:email:' + norm);
    if (!sid) return null;
    return await k.get('session:' + sid);
  } catch (err) {
    console.warn('KV email lookup failed:', err.message);
    return null;
  }
}

module.exports = {
  parseCookies,
  buildTouch,
  classifyTouch,
  getSession,
  upsertTouch,
  attachSubmission,
  findSessionByMondayId,
  findSessionByEmail,
  SESSION_TTL,
  TOUCH_CAP
};
