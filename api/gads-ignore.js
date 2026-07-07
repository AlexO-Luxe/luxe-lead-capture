// ============================================================
//  Manage the Google Ads replay ignore list.
//  GET /api/gads-ignore?secret=<CRON_SECRET>
//      -> list currently ignored mondayId|action pairs
//  GET /api/gads-ignore?secret=...&mondayId=123&action=Confirmed%20Booking
//      -> ignore that item (replay skips it, never alerts)
//  GET /api/gads-ignore?secret=...&mondayId=123&action=...&remove=1
//      -> un-ignore
//
//  Use when a lead/booking can never upload and is not worth chasing, e.g. a
//  lead mislabelled PPC with no email/phone/gclid.
// ============================================================

const { setIgnore, listIgnored } = require('./_log.js');
const { logError } = require('./_errlog.js');

module.exports = async function handler (req, res) {
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (req.query?.secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const mondayId = req.query?.mondayId;
    const action   = req.query?.action || 'Confirmed Booking';
    const remove   = req.query?.remove === '1';

    if (!mondayId) {
      return res.status(200).json({ ignored: await listIgnored() });
    }

    const key = await setIgnore(mondayId, action, !remove);
    return res.status(200).json({ ok: true, key, ignored: !remove, list: await listIgnored() });
  } catch (err) {
    console.error('gads-ignore error:', err.message);
    await logError('gads-ignore', err);
    return res.status(500).json({ error: err.message });
  }
};
