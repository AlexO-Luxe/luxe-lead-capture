// ============================================================
//  Student Luxe — High Potential Lead Conversion Upload
//  Deploy to: /api/submit-high-potential.js
//
//  Triggered by a Monday.com webhook when the
//  'potential_to_book' column (color_mkt29g1r) changes
//  to 'High Potential' on the Leads board.
//
//  Only fires if:
//  - lead_source (color_mkxk8y67) = 'PPC'
//  - gclid (text4__1) is present
//
//  Environment variables required:
//    MONDAY_API_KEY
//    GOOGLE_ADS_CLIENT_ID
//    GOOGLE_ADS_CLIENT_SECRET
//    GOOGLE_ADS_REFRESH_TOKEN
//    GOOGLE_ADS_CUSTOMER_ID
//    GOOGLE_ADS_DEVELOPER_TOKEN
//    GOOGLE_ADS_HIGH_POTENTIAL_ACTION_ID
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
    console.log('High Potential webhook received:', JSON.stringify(body));

    // ── MONDAY WEBHOOK CHALLENGE ──────────────────────────────
    // Monday sends a challenge on first setup — respond to verify
    if (body.challenge) {
      console.log('Monday challenge received, responding');
      return res.status(200).json({ challenge: body.challenge });
    }

    const event = body.event;
    if (!event) {
      console.log('No event in payload, skipping');
      return res.status(200).json({ skipped: true, reason: 'no event' });
    }

    // ── VERIFY TRIGGER CONDITIONS ─────────────────────────────
    // Only fire when value changes TO 'High Potential'
    const newValue = (event.value?.label?.text || (typeof event.value?.label === 'string' ? event.value.label : '') || '').toString();
    if (!newValue.toLowerCase().includes('high potential')) {
      console.log('Not High Potential status, skipping. Value was:', newValue);
      return res.status(200).json({ skipped: true, reason: 'not high potential' });
    }

    const itemId = event.pulseId || event.itemId;
    if (!itemId) {
      console.log('No item ID in event, skipping');
      return res.status(200).json({ skipped: true, reason: 'no item id' });
    }

    // ── FETCH ITEM DATA FROM MONDAY ───────────────────────────
    // Get gclid, lead source, and creation timestamp
    const query = `
      query {
        items(ids: [${itemId}]) {
          id
          name
          created_at
          column_values(ids: ["text4__1", "color_mkxk8y67", "mirror28__1"]) {
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

    const gclid      = cols['text4__1'];
    const leadSource = cols['color_mkxk8y67'];
    const timestamp  = cols['mirror28__1'] || item.created_at;

    console.log('Item data:', { itemId, gclid, leadSource, timestamp });

    // ── GUARD: Only fire for PPC leads with a gclid ───────────
    if (!gclid) {
      console.log('No gclid present, skipping conversion upload');
      return res.status(200).json({ skipped: true, reason: 'no gclid' });
    }

    if (!leadSource.toLowerCase().includes('ppc')) {
      console.log('Lead source is not PPC, skipping. Source was:', leadSource);
      return res.status(200).json({ skipped: true, reason: 'not ppc' });
    }

    // ── UPLOAD CONVERSION TO GOOGLE ADS ──────────────────────
    await uploadConversion({
      gclid,
      timestamp,
      value:    300.0,
      currency: 'GBP',
      actionId: process.env.GOOGLE_ADS_HIGH_POTENTIAL_ACTION_ID
    });

    console.log('High Potential conversion uploaded successfully for item:', itemId);
    return res.status(200).json({ success: true, itemId, gclid });


  } catch (err) {
    console.error('submit-high-potential error:', err.message);
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

  // Use standalone customer ID in URL and conversion action resource name
  const customerId       = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
  const mccId            = '6046238343';
  const conversionAction = `customers/${customerId}/conversionActions/${actionId}`;
  const endpoint         = `https://googleads.googleapis.com/v20/customers/${customerId}:uploadClickConversions`;

  console.log('Upload details:', { endpoint, conversionAction, gclid, conversionTime, value });

  // Step 3 — Upload to Google Ads Conversions API
  const gadsRes = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Authorization':    `Bearer ${tokenData.access_token}`,
      'developer-token':  process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'login-customer-id': mccId,
      'Content-Type':     'application/json'
    },
    body: JSON.stringify({
      conversions: [{
        gclid,
        conversionAction:    conversionAction,
        conversionDateTime: conversionTime,
        conversionValue:     value,
        currencyCode:        currency
      }],
      partialFailure: true
    })
  });

  const rawText = await gadsRes.text();
  console.log('Google Ads raw response (status ' + gadsRes.status + '):', rawText.substring(0, 800));

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

  console.log('Google Ads conversion uploaded successfully');
  return gadsData;
}
