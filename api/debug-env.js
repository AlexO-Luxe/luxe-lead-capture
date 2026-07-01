// ============================================================
//  TEMPORARY debug endpoint — confirms what the live deployed
//  function actually sees for the Data Manager env vars.
//  Delete after use.
// ============================================================
module.exports = async function handler (req, res) {
  if (req.query?.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const mask = (v) => v ? `SET (${v.length} chars, starts "${v.slice(0, 4)}")` : 'MISSING/EMPTY';
  return res.status(200).json({
    GCP_PROJECT_ID:                          mask(process.env.GCP_PROJECT_ID),
    GOOGLE_ADS_LOGIN_CUSTOMER_ID:             mask(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
    GOOGLE_ADS_MODERATE_POTENTIAL_ACTION_ID:  mask(process.env.GOOGLE_ADS_MODERATE_POTENTIAL_ACTION_ID),
    GOOGLE_ADS_HIGH_POTENTIAL_ACTION_ID:      mask(process.env.GOOGLE_ADS_HIGH_POTENTIAL_ACTION_ID),
    GOOGLE_ADS_CUSTOMER_ID:                   mask(process.env.GOOGLE_ADS_CUSTOMER_ID),
    deployedAt: new Date().toISOString()
  });
};
