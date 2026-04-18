// ============================================================
//  Student Luxe — Confirmed Booking Conversion Upload
//  Deploy to: /api/submit-booking.js
//
//  Triggered by a Monday.com webhook when the
//  'status' column changes to 'Confirmed Booking'
//  on the Booking Flow board (ID: 2171015589).
//
//  Only fires if:
//  - lead_source (lookup_mkxtxk48) = 'PPC'
//  - gclid (mirror21__1) is present
//
//  Conversion value is read from formula2 (e.g. '£4,000')
//  and stripped to a clean float before sending to Google.
//
//  Environment variables required:
//    MONDAY_API_KEY
//    GOOGLE_ADS_CLIENT_ID
//    GOOGLE_ADS_CLIENT_SECRET
//    GOOGLE_ADS_REFRESH_TOKEN
//    GOOGLE_ADS_CUSTOMER_ID
//    GOOGLE_ADS_DEVELOPER_TOKEN
//    GOOGLE_ADS_BOOKING_ACTION_ID
// ============================================================

const MONDAY_API = 'https://api.monday.com/v2';

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    console.log('Confirmed Booking webhook received:', JSON.stringify(body));

    // ── MONDAY WEBHOOK CHALLENGE ──────────────────────────────
    if (body.challenge) {
      console.log('Monday challenge received, responding');
      return res.status(200).json({ challenge: body.challenge });
    }

    const event = body.event;
    if (!event) {
      console.log('No event in payload, skipping');
      return res.status(200).json({ skipped: true, reason: 'no event' });
    }

    // ── VERIFY TRIGGER: Must be 'Confirmed Booking' ───────────
    const newValue = event.value?.label?.text || event.value?.label || '';
    if (!newValue.toLowerCase().includes('confirmed booking')) {
      console.log('Not Confirmed Booking status, skipping. Value was:', newValue);
      return res.status(200).json({ skipped: true, reason: 'not confirmed booking' });
    }

    const itemId = event.pulseId || event.itemId;
    if (!itemId) {
      console.log('No item ID in event, skipping');
      return res.status(200).json({ skipped: true, reason: 'no item id' });
    }

    // ── FETCH ITEM DATA FROM MONDAY ───────────────────────────
    // Get gclid (mirrored), lead source (lookup), formula2 value, and created_at
    const query = `
      query {
        items(ids: [${itemId}]) {
          id
          name
          created_at
          column_values(ids: ["mirror21__1", "lookup_mkxtxk48", "formula2"]) {
            id
            text
            value
          }
        }
      }
    `;

    const mondayRes = await fetch(MONDAY_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': process.env.MONDAY_API_KEY
      },
      body: JSON.stringify({ query })
    });

    const mondayData = await mondayRes.json();
    const item = mondayData?.data?.items?.[0];

    if (!item) {
      console.error('Item not found in Monday:', itemId);
      return res.status(200).json({ skipped: true, reason: 'item not found' });
    }

    // Extract column values
    const cols = {};
    item.column_values.forEach(c => { cols[c.id] = c.text || ''; });

    const gclid      = cols['mirror21__1'];
    const leadSource = cols['lookup_mkxtxk48'];
    const formula2   = cols['formula2'];
    const timestamp  = item.created_at;

    console.log('Item data:', { itemId, gclid, leadSource, formula2, timestamp });

    // ── GUARD: Only fire for PPC leads with a gclid ───────────
    if (!gclid) {
      console.log('No gclid present, skipping conversion upload');
      return res.status(200).json({ skipped: true, reason: 'no gclid' });
    }

    if (!leadSource.toLowerCase().includes('ppc')) {
      console.log('Lead source is not PPC, skipping. Source was:', leadSource);
      return res.status(200).json({ skipped: true, reason: 'not ppc' });
    }

    // ── PARSE FORMULA VALUE ───────────────────────────────────
    // formula2 comes back as e.g. '£4,000' or '£1,250.50'
    // Strip £, commas, spaces and parse as float
    const cleanValue = parseFloat(
      (formula2 || '0').replace(/[£$€,\s]/g, '')
    );

    if (!cleanValue || cleanValue <= 0) {
      console.error('Invalid formula2 value:', formula2, '→ parsed as:', cleanValue);
      return res.status(200).json({ skipped: true, reason: 'invalid conversion value' });
    }

    console.log('Conversion value parsed:', formula2, '→', cleanValue);

    // ── UPLOAD CONVERSION TO GOOGLE ADS ──────────────────────
    await uploadConversion({
      gclid,
      timestamp,
      value:    cleanValue,
      currency: 'GBP',
      actionId: process.env.GOOGLE_ADS_BOOKING_ACTION_ID
    });

    console.log('Confirmed Booking conversion uploaded successfully for item:', itemId, 'value: £' + cleanValue);
    return res.status(200).json({ success: true, itemId, gclid, value: cleanValue });

  } catch (err) {
    console.error('submit-booking error:', err.message);
    // Return 200 so Monday doesn't retry endlessly
    return res.status(200).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────────────────────
//  GOOGLE ADS CONVERSION UPLOAD
// ──────────────────────────────────────────────────────────────
async function uploadConversion({ gclid, timestamp, value, currency, actionId }) {

  // Step 1 — Get fresh access token
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

  // Step 2 — Format timestamp
  const rawTime        = timestamp ? new Date(timestamp) : new Date();
  const conversionTime = rawTime.toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '+00:00');

  const customerId       = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
  const conversionAction = `customers/${customerId}/conversionActions/${actionId}`;

  console.log('Uploading conversion:', { gclid, conversionTime, value, conversionAction });

  // Step 3 — Upload to Google Ads Conversions API
  const gadsRes = await fetch(
    `https://googleads.googleapis.com/v18/customers/${customerId}:uploadClickConversions`,
    {
      method:  'POST',
      headers: {
        'Authorization':   `Bearer ${tokenData.access_token}`,
        'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        'login-customer-id': '6046238343',
        'Content-Type':    'application/json'
      },
      body: JSON.stringify({
        conversions: [{
          gclid,
          conversion_action:    conversionAction,
          conversion_date_time: conversionTime,
          conversion_value:     value,
          currency_code:        currency
        }],
        partial_failure: true
      })
    }
  );

  const rawText = await gadsRes.text();
  console.log('Google Ads raw response (status ' + gadsRes.status + '):', rawText.substring(0, 500));

  if (!rawText.trim().startsWith('{') && !rawText.trim().startsWith('[')) {
    throw new Error('Google Ads returned non-JSON (status ' + gadsRes.status + '): ' + rawText.substring(0, 200));
  }

  const gadsData = JSON.parse(rawText);

  if (gadsData.partialFailureError) {
    throw new Error('Partial failure: ' + JSON.stringify(gadsData.partialFailureError));
  }
  if (gadsData.error) {
    throw new Error('API error: ' + JSON.stringify(gadsData.error));
  }

  return gadsData;
}
