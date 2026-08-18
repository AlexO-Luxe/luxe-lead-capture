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

module.exports = { PARTNERS, partnerByKey, partnerByUsername, issueToken, readToken, requirePartner, passcodeMatches, applyCors };
