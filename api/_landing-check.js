// ============================================================
//  Did the conversions we uploaded actually land?
//
//  Every upload path logs "uploaded" the moment Google's API accepts the
//  request. Acceptance is not the same as a recorded conversion: Google
//  validates asynchronously and can drop an event without telling us. Three
//  junk leads could not be retracted in August 2026 because Google held no
//  Step 1 conversion for them at all, and nothing in the system noticed.
//
//  This compares, for a day old enough to have settled, the Step 1 uploads
//  we logged against the conversions Google reports BY CONVERSION DATE
//  (all_conversions_by_conversion_date, not the default click-date metric,
//  which would compare two different things).
//
//  Uploads with no click id are counted separately and excluded from the
//  landing rate: they carry only a hashed email, so Google can only record
//  one when it independently matches the person to a click. Those legitimately
//  do not land most of the time, and mixing them in made the gap look like
//  30% when the real shortfall is closer to 7%.
// ============================================================

const { readGadsEvents } = require('./_log.js');

// Google needs time to process an offline conversion, so a day is only
// judged once it has had this long to settle.
const SETTLE_DAYS = 3;

async function getAccessToken () {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('token failed');
  return d.access_token;
}

async function recordedByDay (since, until) {
  const tok   = await getAccessToken();
  const cid   = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
  const login = ((process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '6046238343').replace(/-/g, '')) || '6046238343';
  const r = await fetch(`https://googleads.googleapis.com/v24/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + tok,
      'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'login-customer-id': login,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: `SELECT segments.date, segments.conversion_action_name,
                     metrics.all_conversions_by_conversion_date
              FROM customer WHERE segments.date BETWEEN "${since}" AND "${until}"`
    })
  });
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error).slice(0, 200));

  const out = {};
  for (const row of (d.results || [])) {
    const name = row.segments?.conversionActionName || '';
    if (!/Step 1/.test(name)) continue;
    const day = row.segments.date;
    out[day] = (out[day] || 0) + Number(row.metrics?.allConversionsByConversionDate || 0);
  }
  return out;
}

// Returns { day, uploaded, withClickId, noClickId, recorded, rate, shortfall }
// for the most recent settled day, or null when there is nothing to judge.
async function checkLanding ({ settleDays = SETTLE_DAYS } = {}) {
  const dayMs  = 86400000;
  const target = new Date(Date.now() - settleDays * dayMs).toISOString().slice(0, 10);

  const startMs = new Date(target + 'T00:00:00Z').getTime();
  const events  = await readGadsEvents(startMs, startMs + dayMs);
  const step1   = events.filter(e => e.ok && /Step 1 NEW/.test(e.action || ''));
  if (!step1.length) return null;

  const withClickId = step1.filter(e => e.hasGclid || e.hasGbraid || e.hasWbraid).length;
  const noClickId   = step1.length - withClickId;

  const recorded = Math.round((await recordedByDay(target, target))[target] || 0);

  // The rate is judged against click-carrying uploads only. Enhanced-only
  // uploads can also land, so the rate can exceed 100%, which is fine: it
  // means more matched than the floor we measured against.
  const rate = withClickId ? Math.round((recorded / withClickId) * 100) : null;

  return {
    day: target,
    uploaded: step1.length,
    withClickId,
    noClickId,
    recorded,
    rate,
    shortfall: Math.max(0, withClickId - recorded)
  };
}

module.exports = { checkLanding, SETTLE_DAYS };
