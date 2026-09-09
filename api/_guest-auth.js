// ============================================================
//  Guest Services portal, shared auth helpers.
//
//  Used by /api/guest-session (sign in) and /api/guest-partners
//  (read partner perks). Booking reference + surname is weak
//  authentication by design, so everything here assumes the pair
//  can be guessed: rate limit hard, keep sessions short, and never
//  put anything in the token worth stealing.
//
//  Token: base64url(payload).base64url(HMAC-SHA256). No cookie.
//  The Squarespace block keeps it in sessionStorage and sends it
//  as `Authorization: Bearer <token>`, which sidesteps Safari
//  third-party cookie blocking entirely (the block runs on
//  studentluxe.co.uk, this API on a Vercel domain).
// ============================================================

const crypto = require('crypto');

const MONDAY_API = 'https://api.monday.com/v2';
const TOKEN_TTL_SECONDS = Number(process.env.GUEST_SESSION_TTL_SECONDS || 60 * 60 * 12);

// ── CORS ──────────────────────────────────────────────────────
// Allowlist, not '*': these endpoints return guest names and partner
// codes, so the origin must be one we published the block on.
function allowedOrigins () {
  return (process.env.GUEST_PORTAL_ORIGINS ||
    'https://www.studentluxe.co.uk,https://studentluxe.co.uk')
    .split(',').map(s => s.trim()).filter(Boolean);
}

function applyCors (req, res) {
  const origin = req.headers.origin || '';
  const list   = allowedOrigins();
  if (list.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ── TOKENS ────────────────────────────────────────────────────
function b64url (buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url (str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function secret () {
  const s = process.env.GUEST_PORTAL_SECRET;
  if (!s) throw new Error('GUEST_PORTAL_SECRET is not set');
  return s;
}

function sign (payloadB64) {
  return b64url(crypto.createHmac('sha256', secret()).update(payloadB64).digest());
}

function issueToken (guest) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    ref:   guest.ref,
    id:    guest.id,
    first: guest.first || '',
    city:  guest.city  || '',
    iat:   now,
    exp:   now + TOKEN_TTL_SECONDS
  };
  const body = b64url(JSON.stringify(payload));
  return { token: body + '.' + sign(body), expiresIn: TOKEN_TTL_SECONDS };
}

function readToken (req) {
  // Everything here runs on attacker-supplied input, so nothing may throw:
  // a bad token must read as "not signed in", never as a 500. Base64
  // decoding silently drops invalid characters, which used to hand
  // timingSafeEqual two different-length buffers and crash the function.
  try {
    const header = (req.headers && req.headers.authorization) || '';
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!raw || raw.indexOf('.') === -1) return null;

    const parts = raw.split('.');
    const body = parts[0];
    const mac  = parts[1];
    if (!body || !mac) return null;

    const expected = sign(body);
    // Compare the base64url text as ASCII rather than the decoded bytes:
    // equal string length is checked first, and decoding is exactly what
    // let malformed input reach timingSafeEqual with mismatched lengths.
    if (mac.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(mac, 'ascii'), Buffer.from(expected, 'ascii'))) return null;

    const payload = JSON.parse(unb64url(body).toString('utf8'));
    if (!payload || typeof payload.exp !== 'number') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

function requireGuest (req, res) {
  const guest = readToken(req);
  if (!guest) {
    res.status(401).json({ error: 'Session expired. Sign in again.' });
    return null;
  }
  return guest;
}

// ── RATE LIMITING ─────────────────────────────────────────────
// Redis counters, sliding by TTL. Deliberately fails OPEN: what sits
// behind this endpoint is partner discount codes, so a Redis outage
// should not lock every guest out of the portal.
let _kv = null;
async function kv () {
  if (_kv) return _kv;
  const { Redis } = await import('@upstash/redis');
  _kv = Redis.fromEnv();
  return _kv;
}

function clientIp (req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Read a counter and report whether the caller is already over the limit.
 * Does NOT increment: callers decide what counts as an attempt, so a guest
 * who signs in first time does not spend the budget meant for guessers.
 * @returns {Promise<boolean>} true when over the limit
 */
async function isRateLimited (key, limit) {
  try {
    const k = await kv();
    const hits = Number(await k.get('guest:rl:' + key)) || 0;
    return hits >= limit;
  } catch (err) {
    return false;
  }
}

/**
 * Count one failed attempt against a key.
 * The TTL is refreshed on every hit, not just the first: a single missed
 * EXPIRE used to leave a key with no TTL, which meant one guest could be
 * locked out permanently with no window to wait for.
 */
async function bumpRateLimit (key, windowSeconds) {
  try {
    const k = await kv();
    const redisKey = 'guest:rl:' + key;
    await k.incr(redisKey);
    await k.expire(redisKey, windowSeconds);
  } catch (err) {
    /* limiter is best effort, never block a guest on Redis */
  }
}

async function kvGet (key) {
  try { const k = await kv(); return await k.get(key); }
  catch (err) { return null; }
}

async function kvSet (key, value, ttlSeconds) {
  try { const k = await kv(); await k.set(key, value, { ex: ttlSeconds }); }
  catch (err) { /* cache is optional */ }
}

// ── MONDAY ────────────────────────────────────────────────────
// Retry on transient failures, per repo rule. Monday answers 200 with
// an `errors` array on GraphQL problems, so status alone is not enough.
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

// Booking references and surnames arrive from a public form, so they are
// never concatenated into a query raw.
function gqlString (value) {
  return JSON.stringify(String(value == null ? '' : value));
}

// Comparison key for names and references: case, spaces, punctuation and
// accents all ignored, so "o'brien", "O Brien" and "OBrien" match.
function normalise (s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // combining accents
    .replace(/[^a-z0-9]/g, '');
}

// Surname check for sign in. Accepts the linked lead's last name, the
// first name, or any word of the booking item name (rows get titled
// "Jane Smith", "Smith, Jane" or "Smith, Jane, Chelsea"), and either
// half of a double-barrelled name.
function surnameMatches (candidates, surname) {
  const wanted = normalise(surname);
  if (!wanted) return false;

  const words = [];
  (candidates || []).forEach(c => {
    if (!c) return;
    words.push(normalise(c));
    String(c).split(/[\s,\-/]+/).forEach(w => { if (w) words.push(normalise(w)); });
  });

  return words.indexOf(wanted) !== -1;
}

module.exports = {
  MONDAY_API,
  applyCors,
  surnameMatches,
  issueToken,
  readToken,
  requireGuest,
  isRateLimited,
  bumpRateLimit,
  clientIp,
  kvGet,
  kvSet,
  monday,
  gqlString,
  normalise
};
