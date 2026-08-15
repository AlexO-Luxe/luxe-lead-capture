// ============================================================
//  Student Luxe — WhatsApp Lead Conversion Upload
//  Deploy to: /api/whatsapp-lead-convert.js
//
//  POST /api/whatsapp-lead-convert
//  Called by Oskar when an agent creates a Monday lead from a
//  WhatsApp conversation. Uploads a Step 1 NEW conversion via
//  the Data Manager API using the stored click bundle (if the
//  guest arrived with an enquiry ref) plus the hashed phone,
//  so we never upload a gclid-only event.
//
//  Body: {
//    ref:          'SL-XXXX' (optional),
//    phone:        '+447700900123' (required for matching),
//    email:        optional,
//    firstName:    optional,
//    lastName:     optional,
//    mondayItemId: Monday item id, used for the transactionId
//  }
//
//  Auth: CRON_SECRET as ?secret= or Bearer (repo convention).
// ============================================================

const { logError } = require('./_errlog.js');
const {
  conversionDestination,
  buildUserIdentifiers,
  ingestEvents,
  cleanGclid,
  CONSENT_GRANTED,
} = require('./_dataManager.js');

let _kv = null;
async function kv() {
  if (_kv) return _kv;
  const { Redis } = await import('@upstash/redis');
  _kv = Redis.fromEnv();
  return _kv;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const q = req.query || {};
    const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (process.env.CRON_SECRET && q.secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const p = req.body || {};
    if (!p.mondayItemId) return res.status(400).json({ error: 'mondayItemId required' });

    // Pull the click bundle when the guest carried an enquiry ref
    let bundle = null;
    if (p.ref && /^SL-[2-9A-HJKMNP-Z]{4,8}$/.test(String(p.ref).toUpperCase())) {
      try {
        const k = await kv();
        bundle = await k.get('waref:' + String(p.ref).toUpperCase());
      } catch (e) {
        console.error('whatsapp-lead-convert: KV read failed (continuing):', e.message);
      }
    }

    // Click identifiers, strict oneof priority gclid > gbraid > wbraid
    const adIdentifiers = {};
    if (bundle) {
      const gclid = cleanGclid(bundle.gclid, bundle.gbraid, bundle.wbraid);
      if (gclid) adIdentifiers.gclid = gclid;
      else if (bundle.gbraid) adIdentifiers.gbraid = bundle.gbraid;
      else if (bundle.wbraid) adIdentifiers.wbraid = bundle.wbraid;
    }

    // Hashed phone (and anything else we have) for enhanced matching
    const userIdentifiers = buildUserIdentifiers({
      email: p.email,
      phone: p.phone,
      firstName: p.firstName,
      lastName: p.lastName,
      regionCode: 'GB',
    });

    if (!Object.keys(adIdentifiers).length && !userIdentifiers.length) {
      return res.status(200).json({ skipped: true, reason: 'no_identifiers' });
    }

    const event = {
      // Always server-now: historic timestamps trigger EVENT_TIME_INVALID
      eventTimestamp: new Date().toISOString(),
      destinationReferences: ['sl-step1-new'],
      // Dedupe convention shared with replay/dissonance tooling
      transactionId: 'walead:' + String(p.mondayItemId),
      eventSource: 'WEB',
      currency: 'GBP',
      conversionValue: 1.0,
    };
    if (Object.keys(adIdentifiers).length) event.adIdentifiers = adIdentifiers;
    if (userIdentifiers.length) event.userData = { userIdentifiers };

    const body = {
      destinations: [
        conversionDestination({
          conversionActionId: process.env.GOOGLE_ADS_CONVERSION_ACTION_ID,
          reference: 'sl-step1-new',
        }),
      ],
      events: [event],
      consent: CONSENT_GRANTED,
    };

    const result = await ingestEvents(body);
    console.log('whatsapp-lead-convert: uploaded', {
      mondayItemId: p.mondayItemId,
      ref: p.ref || null,
      hadClickId: !!Object.keys(adIdentifiers).length,
      hadUserIds: !!userIdentifiers.length,
    });

    return res.status(200).json({
      success: true,
      usedRef: !!bundle,
      hadClickId: !!Object.keys(adIdentifiers).length,
      result,
    });
  } catch (err) {
    console.error('whatsapp-lead-convert error:', err.message);
    await logError('whatsapp-lead-convert', err);
    return res.status(500).json({ error: err.message });
  }
};
