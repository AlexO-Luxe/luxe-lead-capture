// ============================================================
//  Student Luxe — WhatsApp Ref Lookup
//  Deploy to: /api/whatsapp-ref.js
//
//  GET /api/whatsapp-ref?code=SL-XXXX
//  Called by Oskar (Cloudflare Worker) when it spots an
//  "(enquiry ref SL-XXXX)" in an inbound WhatsApp message.
//  Returns the click bundle stored by submit-whatsapp.js.
//
//  Auth: CRON_SECRET as ?secret= or Bearer (repo convention).
// ============================================================

const { logError } = require('./_errlog.js');

let _kv = null;
async function kv() {
  if (_kv) return _kv;
  const { Redis } = await import('@upstash/redis');
  _kv = Redis.fromEnv();
  return _kv;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const q = req.query || {};
    const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (process.env.CRON_SECRET && q.secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const code = String(q.code || '').trim().toUpperCase();
    if (!/^SL-[2-9A-HJKMNP-Z]{4,8}$/.test(code)) {
      return res.status(400).json({ error: 'Invalid ref format' });
    }

    const k = await kv();
    const bundle = await k.get('waref:' + code);
    if (!bundle) return res.status(200).json({ found: false });

    return res.status(200).json({ found: true, ref: code, bundle });
  } catch (err) {
    console.error('whatsapp-ref error:', err.message);
    await logError('whatsapp-ref', err);
    return res.status(500).json({ error: err.message });
  }
};
