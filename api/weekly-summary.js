// ============================================================
//  Student Luxe — Weekly Conversion Summary
//  Deploy to: /api/weekly-summary.js
//
//  Runs every Friday at 9:00am UTC via Vercel cron.
//  Queries Google Ads for conversion counts since last Friday 9:01am.
//  Sends a summary email to alex@studentluxe.co.uk via Resend.
//
//  Add to vercel.json:
//  {
//    "crons": [{
//      "path": "/api/weekly-summary",
//      "schedule": "0 9 * * 5"
//    }]
//  }
//
//  Environment variables required:
//    GOOGLE_ADS_CLIENT_ID
//    GOOGLE_ADS_CLIENT_SECRET
//    GOOGLE_ADS_REFRESH_TOKEN
//    GOOGLE_ADS_CUSTOMER_ID
//    GOOGLE_ADS_DEVELOPER_TOKEN
//    GOOGLE_ADS_CONVERSION_ACTION_ID       (Step 1)
//    GOOGLE_ADS_MODERATE_POTENTIAL_ACTION_ID (Step 2)
//    GOOGLE_ADS_HIGH_POTENTIAL_ACTION_ID   (Step 3)
//    GOOGLE_ADS_BOOKING_ACTION_ID          (Step 4)
//    RESEND_API_KEY
// ============================================================

const RESEND_API = 'https://api.resend.com/emails';
const MCC_ID     = '6046238343';

// ── Conversion action definitions ────────────────────────────
function getConversionActions() {
  const customerId = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
  return [
    {
      step:     1,
      label:    'Server-side enquiry form',
      actionId: process.env.GOOGLE_ADS_CONVERSION_ACTION_ID,
      resource: `customers/${customerId}/conversionActions/${process.env.GOOGLE_ADS_CONVERSION_ACTION_ID}`,
      value:    '£1 fixed',
      color:    '#4A90D9'
    },
    {
      step:     2,
      label:    'Moderate potential leads',
      actionId: process.env.GOOGLE_ADS_MODERATE_POTENTIAL_ACTION_ID,
      resource: `customers/${customerId}/conversionActions/${process.env.GOOGLE_ADS_MODERATE_POTENTIAL_ACTION_ID}`,
      value:    '£150 fixed',
      color:    '#F5A623'
    },
    {
      step:     3,
      label:    'High potential leads',
      actionId: process.env.GOOGLE_ADS_HIGH_POTENTIAL_ACTION_ID,
      resource: `customers/${customerId}/conversionActions/${process.env.GOOGLE_ADS_HIGH_POTENTIAL_ACTION_ID}`,
      value:    '£300 fixed',
      color:    '#E8703A'
    },
    {
      step:     4,
      label:    'Confirmed bookings',
      actionId: process.env.GOOGLE_ADS_BOOKING_ACTION_ID,
      resource: `customers/${customerId}/conversionActions/${process.env.GOOGLE_ADS_BOOKING_ACTION_ID}`,
      value:    'variable',
      color:    '#417505'
    }
  ];
}

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Allow manual trigger via POST with { "manual": true }
  // Cron hits GET, manual hits POST
  const isManual = req.method === 'POST';

  try {
    // ── DATE RANGE: last Friday 9:01am → now ─────────────────
    const now = new Date();
    const lastFriday = getLastFriday9am(now);

    const dateFrom = formatGadsDate(lastFriday);
    const dateTo   = formatGadsDate(now);

    console.log(`Weekly summary: ${dateFrom} → ${dateTo}`);

    // ── GET GOOGLE ADS ACCESS TOKEN ───────────────────────────
    const accessToken = await getAccessToken();

    // ── QUERY CONVERSION COUNTS ───────────────────────────────
    const customerId = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
    const actions    = getConversionActions();
    const results    = await fetchConversionCounts(accessToken, customerId, dateFrom, dateTo, actions);

    // ── FETCH STEP 4 ITEMISED BREAKDOWN ───────────────────────
    const bookingBreakdown = await fetchBookingBreakdown(accessToken, customerId, dateFrom, dateTo, actions[3].resource);

    // ── BUILD AND SEND EMAIL ──────────────────────────────────
    await sendSummaryEmail({ results, bookingBreakdown, dateFrom, dateTo, now });

    console.log('Weekly summary email sent successfully');
    return res.status(200).json({ success: true, dateFrom, dateTo, results });

  } catch (err) {
    console.error('Weekly summary error:', err.message);
    // Still return 200 so Vercel doesn't retry aggressively
    return res.status(200).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────────────────────
//  DATE HELPERS
// ──────────────────────────────────────────────────────────────
function getLastFriday9am(now) {
  const d = new Date(now);
  // Go back to find last Friday
  const dayOfWeek = d.getUTCDay(); // 0=Sun, 5=Fri
  const daysBack  = dayOfWeek === 5
    ? 7   // It's Friday now — go back a full week
    : (dayOfWeek + 2) % 7 + (dayOfWeek < 5 ? 0 : 0); // days since last Friday

  // Calculate days since last Friday
  const daysSince = dayOfWeek >= 5
    ? dayOfWeek - 5
    : dayOfWeek + 2;

  d.setUTCDate(d.getUTCDate() - (daysSince === 0 ? 7 : daysSince));
  d.setUTCHours(9, 1, 0, 0); // 9:01am UTC
  return d;
}

function formatGadsDate(date) {
  // Google Ads API requires YYYY-MM-DD
  return date.toISOString().split('T')[0];
}

function formatDisplayDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function formatDisplayDateTime(date) {
  return date.toLocaleString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'Europe/London'
  }).replace(', ', ' at ');
}

// ──────────────────────────────────────────────────────────────
//  GOOGLE ADS AUTH
// ──────────────────────────────────────────────────────────────
async function getAccessToken() {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error('Failed to get access token: ' + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

// ──────────────────────────────────────────────────────────────
//  FETCH CONVERSION COUNTS via Google Ads Query Language
// ──────────────────────────────────────────────────────────────
async function fetchConversionCounts(accessToken, customerId, dateFrom, dateTo, actions) {
  const query = `
    SELECT
      conversion_action.resource_name,
      conversion_action.name,
      metrics.conversions,
      metrics.conversions_value
    FROM conversion_action
    WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'
  `;

  const response = await fetch(
    `https://googleads.googleapis.com/v20/customers/${customerId}/googleAds:search`,
    {
      method:  'POST',
      headers: {
        'Authorization':     `Bearer ${accessToken}`,
        'developer-token':   process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        'login-customer-id': MCC_ID,
        'Content-Type':      'application/json'
      },
      body: JSON.stringify({ query })
    }
  );

  const rawText = await response.text();
  console.log('Conversion counts response:', rawText.substring(0, 500));

  let data;
  try { data = JSON.parse(rawText); } catch(e) {
    throw new Error('Non-JSON from Google Ads: ' + rawText.substring(0, 200));
  }

  if (data.error) throw new Error('Google Ads error: ' + JSON.stringify(data.error));

  // Map results back to our actions
  const rows = data.results || [];
  return actions.map(action => {
    const row = rows.find(r =>
      r.conversionAction?.resourceName === action.resource
    );
    return {
      ...action,
      count: row ? Math.round(parseFloat(row.metrics?.conversions || 0)) : 0,
      totalValue: row ? parseFloat(row.metrics?.conversionsValue || 0) : 0
    };
  });
}

// ──────────────────────────────────────────────────────────────
//  FETCH STEP 4 ITEMISED BREAKDOWN
//  Uses the offline conversion upload history
// ──────────────────────────────────────────────────────────────
async function fetchBookingBreakdown(accessToken, customerId, dateFrom, dateTo, bookingResource) {
  const query = `
    SELECT
      offline_conversion_upload_conversion_action_summary.conversion_action,
      metrics.conversions,
      metrics.conversions_value,
      segments.date
    FROM offline_conversion_upload_conversion_action_summary
    WHERE
      offline_conversion_upload_conversion_action_summary.conversion_action = '${bookingResource}'
      AND segments.date BETWEEN '${dateFrom}' AND '${dateTo}'
    ORDER BY segments.date DESC
  `;

  const response = await fetch(
    `https://googleads.googleapis.com/v20/customers/${customerId}/googleAds:search`,
    {
      method:  'POST',
      headers: {
        'Authorization':     `Bearer ${accessToken}`,
        'developer-token':   process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        'login-customer-id': MCC_ID,
        'Content-Type':      'application/json'
      },
      body: JSON.stringify({ query })
    }
  );

  const rawText = await response.text();
  console.log('Booking breakdown response:', rawText.substring(0, 500));

  let data;
  try { data = JSON.parse(rawText); } catch(e) {
    return []; // Non-fatal — just return empty
  }

  if (data.error) {
    console.warn('Booking breakdown query error (non-fatal):', JSON.stringify(data.error));
    return [];
  }

  return (data.results || []).map(r => ({
    date:  r.segments?.date || '—',
    count: Math.round(parseFloat(r.metrics?.conversions || 0)),
    value: parseFloat(r.metrics?.conversionsValue || 0)
  })).filter(r => r.count > 0);
}

// ──────────────────────────────────────────────────────────────
//  BUILD AND SEND SUMMARY EMAIL
// ──────────────────────────────────────────────────────────────
async function sendSummaryEmail({ results, bookingBreakdown, dateFrom, dateTo, now }) {

  const totalConversions = results.reduce((sum, r) => sum + r.count, 0);
  const totalValue       = results.reduce((sum, r) => sum + r.totalValue, 0);
  const bookingResult    = results.find(r => r.step === 4);
  const bookingTotal     = bookingResult?.totalValue || 0;

  const periodLabel = `${formatDisplayDate(dateFrom)} – ${formatDisplayDate(dateTo)}`;

  // ── Step rows ─────────────────────────────────────────────
  const stepRows = results.map(r => `
    <tr>
      <td style="padding:12px 16px;border-bottom:0.5px solid #ede9e3;vertical-align:middle;">
        <span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:${r.color};color:#fff;font-size:10px;font-weight:600;text-align:center;line-height:22px;margin-right:10px;vertical-align:middle;">${r.step}</span>
        <span style="font-size:13px;color:#1a1a1a;font-weight:500;vertical-align:middle;">${r.label}</span>
      </td>
      <td style="padding:12px 16px;border-bottom:0.5px solid #ede9e3;text-align:center;">
        <span style="font-size:22px;font-weight:700;color:${r.count > 0 ? r.color : '#9b9b9b'};">${r.count}</span>
      </td>
      <td style="padding:12px 16px;border-bottom:0.5px solid #ede9e3;text-align:right;font-size:12px;color:#6b6b6b;">
        ${r.step === 4 && r.totalValue > 0
          ? `<strong style="color:#1a1a1a;">£${r.totalValue.toLocaleString('en-GB', {minimumFractionDigits:2,maximumFractionDigits:2})}</strong>`
          : r.value
        }
      </td>
    </tr>`).join('');

  // ── Booking breakdown rows ────────────────────────────────
  const breakdownRows = bookingBreakdown.length > 0
    ? bookingBreakdown.map(b => `
    <tr>
      <td style="padding:8px 16px;border-bottom:0.5px solid #f0ece3;font-size:12px;color:#6b6b6b;">${formatDisplayDate(b.date)}</td>
      <td style="padding:8px 16px;border-bottom:0.5px solid #f0ece3;font-size:12px;color:#1a1a1a;text-align:center;">${b.count}</td>
      <td style="padding:8px 16px;border-bottom:0.5px solid #f0ece3;font-size:13px;color:#417505;font-weight:600;text-align:right;">£${b.value.toLocaleString('en-GB', {minimumFractionDigits:2,maximumFractionDigits:2})}</td>
    </tr>`).join('')
    : `<tr><td colspan="3" style="padding:16px;text-align:center;font-size:12px;color:#9b9b9b;font-style:italic;">No confirmed bookings uploaded this week</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Weekly Conversion Summary</title></head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.3);">

  <!-- HEADER -->
  <tr><td style="background:#0d1a2e;padding:28px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>
        <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.45);">Weekly Report</p>
        <h1 style="margin:0;font-family:Georgia,serif;font-size:24px;font-weight:400;color:#f0ece2;line-height:1.2;letter-spacing:-0.02em;">Conversion Summary</h1>
        <p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,0.5);">${periodLabel}</p>
      </td>
      <td style="text-align:right;vertical-align:top;">
        <img src="https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/4d6b8086-53ed-4d17-b8f7-20f67be76f41/luxe-white.png?content-type=image%2Fpng" alt="Student Luxe" style="height:36px;width:auto;">
      </td>
    </tr></table>
  </td></tr>

  <!-- SUMMARY PILLS -->
  <tr><td style="background:#ffffff;padding:24px 32px 0;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="50%" style="padding-right:8px;">
        <div style="background:#f7f2eb;border-radius:10px;padding:16px;text-align:center;">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#B8966E;">Total conversions</p>
          <p style="margin:0;font-family:Georgia,serif;font-size:36px;font-weight:400;color:#0d1a2e;letter-spacing:-0.03em;">${totalConversions}</p>
        </div>
      </td>
      <td width="50%" style="padding-left:8px;">
        <div style="background:#f7f2eb;border-radius:10px;padding:16px;text-align:center;">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#B8966E;">Booking revenue</p>
          <p style="margin:0;font-family:Georgia,serif;font-size:36px;font-weight:400;color:#417505;letter-spacing:-0.03em;">£${bookingTotal.toLocaleString('en-GB', {minimumFractionDigits:0,maximumFractionDigits:0})}</p>
        </div>
      </td>
    </tr></table>
  </td></tr>

  <!-- CONVERSION STEPS TABLE -->
  <tr><td style="background:#ffffff;padding:20px 32px 0;">
    <p style="margin:0 0 12px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Conversion funnel</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:0.5px solid #ede9e3;border-radius:10px;overflow:hidden;">
      <thead>
        <tr style="background:#f7f2eb;">
          <th style="padding:10px 16px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9b9b9b;font-weight:500;text-align:left;">Step</th>
          <th style="padding:10px 16px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9b9b9b;font-weight:500;text-align:center;">Count</th>
          <th style="padding:10px 16px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9b9b9b;font-weight:500;text-align:right;">Value</th>
        </tr>
      </thead>
      <tbody>${stepRows}</tbody>
    </table>
  </td></tr>

  <!-- STEP 4 BREAKDOWN -->
  <tr><td style="background:#ffffff;padding:20px 32px 28px;">
    <p style="margin:0 0 12px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Step 4 — Confirmed bookings breakdown</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:0.5px solid #ede9e3;border-radius:10px;overflow:hidden;">
      <thead>
        <tr style="background:#f7f2eb;">
          <th style="padding:10px 16px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9b9b9b;font-weight:500;text-align:left;">Date uploaded</th>
          <th style="padding:10px 16px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9b9b9b;font-weight:500;text-align:center;">Bookings</th>
          <th style="padding:10px 16px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9b9b9b;font-weight:500;text-align:right;">Revenue</th>
        </tr>
      </thead>
      <tbody>${breakdownRows}</tbody>
      ${bookingBreakdown.length > 0 ? `
      <tfoot>
        <tr style="background:#f7f2eb;">
          <td style="padding:10px 16px;font-size:12px;font-weight:600;color:#1a1a1a;">Total</td>
          <td style="padding:10px 16px;font-size:12px;font-weight:600;color:#1a1a1a;text-align:center;">${bookingBreakdown.reduce((s,b)=>s+b.count,0)}</td>
          <td style="padding:10px 16px;font-size:13px;font-weight:700;color:#417505;text-align:right;">£${bookingTotal.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
        </tr>
      </tfoot>` : ''}
    </table>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#f7f2eb;padding:16px 32px;border-top:0.5px solid rgba(184,150,110,0.2);text-align:center;">
    <p style="margin:0;font-size:11px;color:#9b9b9b;line-height:1.8;">
      Student Luxe Apartments &nbsp;·&nbsp; Automated weekly report<br>
      Generated ${formatDisplayDateTime(now)} &nbsp;·&nbsp; Data source: Google Ads Conversions API
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  const res = await fetch(RESEND_API, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      from:    'Student Luxe <reservations@studentluxe.co.uk>',
      to:      ['alex@studentluxe.co.uk'],
      subject: `📊 Weekly Conversions — ${totalConversions} conversions${bookingTotal > 0 ? `, £${bookingTotal.toLocaleString('en-GB',{minimumFractionDigits:0,maximumFractionDigits:0})} bookings` : ''} (${formatDisplayDate(dateFrom).split(' ').slice(0,2).join(' ')} – ${formatDisplayDate(dateTo).split(' ').slice(0,2).join(' ')})`,
      html
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
  return res.json();
}
