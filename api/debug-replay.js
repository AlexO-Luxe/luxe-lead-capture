// ============================================================
//  TEMPORARY debug endpoint — replays a moderate-potential-style
//  event through the real Data Manager helper using LIVE env vars,
//  with validateOnly:true so nothing actually uploads to Google.
//  Delete after use.
// ============================================================
const {
  conversionDestination,
  buildUserIdentifiers,
  ingestEvents,
  CONSENT_GRANTED
} = require('./_dataManager.js');

module.exports = async function handler (req, res) {
  if (req.query?.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const email = 'tylerjlivingston@gmail.com';
    const phone = '+16479990412';
    const firstName = 'Tyler';
    const lastName  = 'Livingston';
    const gclid = 'Cj0KCQjwxvjRBhC2ARIsAI7KJa0hfVoGGUclEI7Ygcg_eiJrqLPzenP3TLHKhcHECc5SNCOLmm5vezsaAkkeEALw_wcB';

    const userIdentifiers = buildUserIdentifiers({ email, phone, firstName, lastName, regionCode: 'GB' });

    const event = {
      destinationReferences: ['sl-lead-potential'],
      transactionId:  'debug-replay:' + email,
      eventTimestamp: new Date().toISOString(),
      eventSource:    'WEB',
      adIdentifiers:  { gclid },
      userData:       { userIdentifiers },
      currency:       'GBP',
      conversionValue: 150.0
    };

    const actionIdToTest = req.query?.actionIdOverride || process.env.GOOGLE_ADS_MODERATE_POTENTIAL_ACTION_ID;
    const destinations = [
      conversionDestination({
        conversionActionId: actionIdToTest,
        reference: 'sl-lead-potential'
      })
    ];

    const result = await ingestEvents({
      destinations,
      events: [event],
      consent: CONSENT_GRANTED,
      validateOnly: true
    });
    return res.status(200).json({ ok: true, result, actionIdUsed: actionIdToTest, payload: { destinations, events: [event] } });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message, errorLength: err.message.length });
  }
};
