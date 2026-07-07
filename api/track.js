// ============================================================
//  Student Luxe / Stay Luxe — Page-view tracking endpoint
//  POST /api/track
//
//  Called from the Squarespace site-wide tracking snippet on every
//  page view. Stores first-touch + last-touch + path history in
//  Vercel KV, keyed by sl_session_id cookie (90d TTL).
//
//  Returns: { session_id, first, last, touchCount }
// ============================================================

const { buildTouch, upsertTouch } = require('./_attribution.js');

function uuid() {
  // RFC 4122 v4 using crypto.randomUUID (Node 18+)
  return crypto.randomUUID();
}

function readSessionId(req) {
  const cookies = (req.headers.cookie || '')
    .split(';')
    .map(s => s.trim())
    .reduce((acc, kv) => {
      const i = kv.indexOf('=');
      if (i > 0) acc[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
      return acc;
    }, {});
  return (req.body && req.body.session_id) || cookies.sl_session_id || null;
}

const { logError } = require('./_errlog.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const sessionId = readSessionId(req) || uuid();
    const touch     = buildTouch(req, req.body || {});
    const record    = await upsertTouch(sessionId, touch);

    // Set cookie so the next call lands on the same session.
    // SameSite=Lax so it survives the Squarespace → Vercel form post.
    res.setHeader('Set-Cookie',
      `sl_session_id=${sessionId}; Path=/; Max-Age=${60 * 60 * 24 * 90}; SameSite=Lax; Secure`
    );

    return res.status(200).json({
      session_id: sessionId,
      first:      record?.first || null,
      last:       record?.last  || null,
      touches:    (record?.touches || []).length
    });
  } catch (err) {
    console.error('track error:', err.message);
    await logError('track', err);
    return res.status(200).json({ error: err.message });
  }
};
