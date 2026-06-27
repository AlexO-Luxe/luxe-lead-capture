// ============================================================
//  Test endpoint for the gads failure alert email.
//  GET /api/test-alert?secret=<CRON_SECRET>
//
//  Fires one sample failure email to alex@studentluxe.co.uk so we
//  can verify deliverability and rendering on mobile.
// ============================================================

const { sendGadsAlert } = require('./_alert.js');

module.exports = async function handler (req, res) {
  if (req.query?.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  await sendGadsAlert({
    source:  'TEST — Student Luxe enquiry',
    action:  'Step 1 NEW (server-side enquiry)',
    payload: {
      email:     'test@example.com',
      name:      'Test Lead',
      mondayId:  '123456789',
      hasGclid:  true,
      hasGbraid: false
    },
    error:   'TEST ALERT: this is what a real failure email looks like. No action needed.'
  });
  return res.status(200).json({ ok: true, sentTo: 'alex@studentluxe.co.uk' });
};
