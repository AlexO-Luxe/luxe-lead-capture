// ============================================================
//  Student Luxe — Lead Potential Conversion Upload
//  Deploy to: /api/submit-high-potential.js
// ============================================================

const MONDAY_API = 'https://api.monday.com/v2';

const POTENTIAL_CONFIG = {
  'high potential': {
    value:    300.0,
    actionId: () => process.env.GOOGLE_ADS_HIGH_POTENTIAL_ACTION_ID,
    label:    'High Potential'
  },
  'moderate potential': {
    value:    150.0,
    actionId: () => process.env.GOOGLE_ADS_MODERATE_POTENTIAL_ACTION_ID,
    label:    'Moderate Potential'
  }
};

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    console.log('Potential webhook received:', JSON.stringify(body));

    if (body.challenge) return res.status(200).json({ challenge: body.challenge });

    const event = body.event;
    if (!event) return res.status(200).json({ skipped: true, reason: 'no event' });

    const newValue = (
      event.value?.label?.text ||
      (typeof event.value?.label === 'string' ? event.value.label : '') || ''
    ).toString().toLowerCase().trim();

    const config = POTENTIAL_CONFIG[newValue];
    if (!config) {
      return res.status(200).json({ skipped: true, reason: 'not a tracked potential status', value: newValue });
    }

    const itemId = event.pulseId || event.itemId;
    if (!itemId) return res.status(200).json({ skipped: true, reason: 'no item id' });

    // ── FETCH LEAD DATA FROM MONDAY ───────────────────────────
    // Fetch gclid, source, timestamp, email and phone directly from leads board
    const query = `
      query {
        items(ids: [${itemId}]) {
          id name created_at
          column_values(ids: ["text4__1", "color_mkxk8y67", "mirror28__1", "email", "phone_1"]) {
            id text value
          }
        }
      }
    `;

    const mondayRes  = await fetch(MONDAY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
      body: JSON.stringify({ query })
    });

    const mondayData = await mondayRes.json();
    const item       = mondayData?.data?.items?.[0];
    if (!item) return res.status(200).json({ skipped: true, reason: 'item not found' });

    const cols = {};
    item.column_values.forEach(c => { cols[c.id] = c.text || ''; });

    const gclid      = cols['text4__1'];
    const leadSource = cols['color_mkxk8y67'];
    const timestamp  = cols['mirror28__1'] || item.created_at;
    const email      = cols['email'];
    const phone      = cols['phone_1'];

    console.log('Item data:', { itemId, gclid, leadSource, timestamp, hasEmail: !!email, hasPhone: !!phone });

    // ── GUARD: Only fire for PPC leads ────────────────────────
    if (!leadSource.toLowerCase().includes('ppc')) {
      console.log('Not PPC, skipping. Source:', leadSource);
      return res.status(200).json({ skipped: true, reason: 'not ppc' });
    }

    // Upload — gclid optional, matched via email/phone when absent
    await uploadConversion({
      gclid,
      email,
      phone,
      timestamp,
      value:    config.value,
      currency: 'GBP',
      actionId: config.actionId()
    });

    console.log(`${config.label} conversion uploaded for item:`, itemId);
    return res.status(200).json({ success: true, itemId, gclid, potential: config.label, value: config.value });

  } catch (err) {
    console.error('submit-high-potential error:', err.message);
    return res.status(200).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────────────────────
//  GOOGLE ADS CONVERSION UPLOAD
// ──────────────────────────────────────────────────────────────
async function uploadConversion({ gclid, email, phone, timestamp, value, currency, actionId }) {

  // Get fresh access token
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
  if (!tokenData.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(tokenData));

  // Hash email and phone for enhanced matching
  async function sha256(str) {
    const encoder    = new TextEncoder();
    const data       = encoder.encode(str.toLowerCase().trim());
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const hashedEmail = email ? await sha256(email) : null;
  const cleanPhone  = phone ? phone.replace(/[\s\-().]/g, '') : null;
  const hashedPhone = cleanPhone ? await sha256(cleanPhone) : null;

  // Format timestamp
  const rawTime        = timestamp ? new Date(timestamp) : new Date();
  const conversionTime = rawTime.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '+00:00');

  const customerId       = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
  const conversionAction = `customers/${customerId}/conversionActions/${actionId}`;
  const endpoint         = `https://googleads.googleapis.com/v20/customers/${customerId}:uploadClickConversions`;

  // Build conversion — gclid optional
  const conversion = {
    conversionAction,
    conversionDateTime: conversionTime,
    conversionValue:    value,
    currencyCode:       currency,
    userIdentifiers: [
      ...(hashedEmail ? [{ hashedEmail }] : []),
      ...(hashedPhone ? [{ hashedPhoneNumber: hashedPhone }] : [])
    ]
  };
  if (gclid) conversion.gclid = gclid;

  console.log('Uploading:', { conversionAction, hasGclid: !!gclid, hasEmail: !!hashedEmail, hasPhone: !!hashedPhone, value });

  const gadsRes = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Authorization':     `Bearer ${tokenData.access_token}`,
      'developer-token':   process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'login-customer-id': '6046238343',
      'Content-Type':      'application/json'
    },
    body: JSON.stringify({ conversions: [conversion], partialFailure: true })
  });

  const rawText = await gadsRes.text();
  console.log('Google Ads response (status ' + gadsRes.status + '):', rawText.substring(0, 800));

  if (!rawText.trim().startsWith('{') && !rawText.trim().startsWith('[')) {
    throw new Error('Google Ads non-JSON (status ' + gadsRes.status + '): ' + rawText.substring(0, 200));
  }

  const gadsData = JSON.parse(rawText);

  if (gadsData.partialFailureError) {
    const errStr = JSON.stringify(gadsData.partialFailureError);
    if (errStr.includes('EXPIRED_EVENT') || errStr.includes('TOO_RECENT_CONVERSION_ACTION')) {
      console.log('Upload skipped (expected):', errStr.substring(0, 200));
      return { skipped: true, reason: 'expired_event' };
    }
    throw new Error('Partial failure: ' + errStr);
  }
  if (gadsData.error) throw new Error('API error: ' + JSON.stringify(gadsData.error));

  console.log('Conversion uploaded successfully');
  return gadsData;
}
