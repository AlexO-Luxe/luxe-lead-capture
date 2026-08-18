// ============================================================
//  Partner portal, shared auth + partner registry.
//
//  Institutions we place students for get a read-only view of
//  their own leads. One shared username and password per partner,
//  held in env vars, exchanged for a signed 12 hour token. No
//  personal contact details ever leave this API: the school sees
//  who enquired and how far along they are, we keep email, phone
//  and message.
//
//  ENV
//    PARTNER_PORTAL_SECRET      required, HMAC key for tokens
//    PARTNER_MARANGONI_USER     required, the shared username
//    PARTNER_MARANGONI_PASSCODE required, the shared password
//    PARTNER_PORTAL_ORIGINS     optional, extra CORS origins
//    PARTNER_SESSION_TTL_SECONDS optional, default 12h
// ============================================================

const crypto = require('crypto');

const MONDAY_API = 'https://api.monday.com/v2';
const TTL = Number(process.env.PARTNER_SESSION_TTL_SECONDS || 60 * 60 * 12);

// A lead belongs to a partner when EITHER the source pair says so
// (Source WHERE = Partnerships and Source HOW = the partner), OR the
// University column names them. The second rule is what catches the
// years of leads captured before the co-branded portal existed.
const PARTNERS = {
  marangoni: {
    key:        'marangoni',
    name:       'Istituto Marangoni London',
    short:      'Istituto Marangoni',
    userEnv:    'PARTNER_MARANGONI_USER',
    passEnv:    'PARTNER_MARANGONI_PASSCODE',
    source:     'Partnerships',
    match:      /istituto\s*marangoni/i,
    logo:       'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/d2ee5c81-8e9f-4ebd-a142-4234962fde80/istituto-marangoni-london-logo-1.png?content-type=image%2Fpng',
  },
};

function partnerByKey (key) {
  return PARTNERS[String(key || '').trim().toLowerCase()] || null;
}

// Sign-in is by username, so the portal URL does not have to say which
// partner it belongs to. Usernames are matched case-insensitively.
function partnerByUsername (username) {
  const given = String(username == null ? '' : username).trim().toLowerCase();
  if (!given) return null;
  return Object.values(PARTNERS).find(p => (process.env[p.userEnv] || '').trim().toLowerCase() === given) || null;
}

function b64url (buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url (str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function secret () {
  const s = process.env.PARTNER_PORTAL_SECRET;
  if (!s) throw new Error('PARTNER_PORTAL_SECRET is not set');
  return s;
}
function sign (payloadB64) {
  return b64url(crypto.createHmac('sha256', secret()).update(payloadB64).digest());
}

function issueToken (partner) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ p: partner.key, iat: now, exp: now + TTL }));
  return { token: body + '.' + sign(body), expiresIn: TTL };
}

// Runs on attacker-supplied input, so nothing may throw: a bad token reads
// as "not signed in", never as a 500.
function readToken (req) {
  try {
    const header = (req.headers && req.headers.authorization) || '';
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!raw || raw.indexOf('.') === -1) return null;

    const [body, mac] = raw.split('.');
    if (!body || !mac) return null;

    const expected = sign(body);
    if (mac.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(mac, 'ascii'), Buffer.from(expected, 'ascii'))) return null;

    const payload = JSON.parse(unb64url(body).toString('utf8'));
    if (!payload || typeof payload.exp !== 'number') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return partnerByKey(payload.p);
  } catch (err) {
    return null;
  }
}

function requirePartner (req, res) {
  const partner = readToken(req);
  if (!partner) {
    res.status(401).json({ error: 'Session expired. Sign in again.' });
    return null;
  }
  return partner;
}

// Password comparison is constant time, and a partner with no password set
// can never be signed into rather than falling open.
function passcodeMatches (partner, supplied) {
  const expected = (process.env[partner.passEnv] || '').trim();
  const given    = String(supplied == null ? '' : supplied).trim();
  if (!expected || !given) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── REDIS ─────────────────────────────────────────────────────
// Same lazy Upstash client as the rest of the app. Every helper below
// fails OPEN: this portal is a read-only view of leads, so a Redis
// outage must not lock a partner out or hide their board.
let _kv = null;
async function kv () {
  if (_kv) return _kv;
  const { Redis } = await import('@upstash/redis');
  _kv = Redis.fromEnv();
  return _kv;
}
async function kvGet (key) {
  try { const k = await kv(); return await k.get(key); }
  catch (err) { return null; }
}
async function kvSet (key, value, ttlSeconds) {
  try { const k = await kv(); await k.set(key, value, { ex: ttlSeconds }); }
  catch (err) { /* cache miss next time, nothing more */ }
}
async function isRateLimited (key, limit) {
  try {
    const k = await kv();
    return (Number(await k.get('partner:rl:' + key)) || 0) >= limit;
  } catch (err) { return false; }
}
async function bumpRateLimit (key, windowSeconds) {
  try {
    const k = await kv();
    const redisKey = 'partner:rl:' + key;
    await k.incr(redisKey);
    await k.expire(redisKey, windowSeconds);
  } catch (err) { /* counter is best effort */ }
}
function clientIp (req) {
  const fwd = (req.headers && req.headers['x-forwarded-for']) || '';
  return String(fwd).split(',')[0].trim() || 'unknown';
}

// ── MONDAY ────────────────────────────────────────────────────
// Retry on transient failures, per repo rule. Monday answers 200 with an
// `errors` array on GraphQL problems, so status alone is not enough.
async function monday (query, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(MONDAY_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': process.env.MONDAY_API_KEY,
          'API-Version': '2024-10'
        },
        body: JSON.stringify({ query })
      });
      const json = await r.json();
      if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 400));
      if (!r.ok) throw new Error('Monday HTTP ' + r.status);
      return json.data;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise(res => setTimeout(res, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

function applyCors (req, res) {
  const list = (process.env.PARTNER_PORTAL_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  if (origin && list.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // The portal is never for search engines, whatever links to it.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

module.exports = {
  PARTNERS, partnerByKey, partnerByUsername,
  issueToken, readToken, requirePartner, passcodeMatches,
  applyCors, monday, kvGet, kvSet, isRateLimited, bumpRateLimit, clientIp
};
