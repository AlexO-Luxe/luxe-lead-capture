// ============================================================
//  POST /api/partner-login   { username: "...", password: "..." }
//    200 { token, expiresIn, partner: { key, name, logo } }
//    401 wrong username or password
//    429 too many attempts from one IP
//
//  Shared username and password per institution, held in env vars.
//  Attempts are rate limited so the pair cannot be walked through.
// ============================================================

const { partnerByUsername, issueToken, passcodeMatches, applyCors } = require('./_partner-auth.js');
const { isRateLimited, bumpRateLimit, clientIp } = require('./_guest-auth.js');
const { logError } = require('./_errlog.js');

const WINDOW_SECONDS = 15 * 60;
const MAX_ATTEMPTS   = 10;

module.exports = async function handler (req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body    = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const partner = partnerByUsername(body.username);
    const ip      = clientIp(req);

    if (await isRateLimited('partner:' + ip, MAX_ATTEMPTS)) {
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    await bumpRateLimit('partner:' + ip, WINDOW_SECONDS);

    // Unknown username and wrong password answer identically, so the endpoint
    // never confirms which usernames exist.
    if (!partner || !passcodeMatches(partner, body.password)) {
      return res.status(401).json({ error: 'Those details were not recognised.' });
    }

    const { token, expiresIn } = issueToken(partner);
    return res.status(200).json({
      token, expiresIn,
      partner: { key: partner.key, name: partner.name, logo: partner.logo }
    });
  } catch (err) {
    await logError('partner-login', err);
    return res.status(500).json({ error: 'Sign in is unavailable right now.' });
  }
};
