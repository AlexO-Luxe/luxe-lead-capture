// ============================================================
//  Student Luxe — Google Ads API Connectivity Test
//  Deploy to: /api/test-gads.js
//  DELETE THIS FILE after debugging is complete
// ============================================================

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const results = {};

  // Test 1 — Can we reach googleapis.com at all?
  try {
    const r = await fetch('https://www.googleapis.com/discovery/v1/apis');
    results.googleapis_discovery = { status: r.status, ok: r.ok };
  } catch(e) {
    results.googleapis_discovery = { error: e.message };
  }

  // Test 2 — Can we reach googleads.googleapis.com with a valid path?
  try {
    const r = await fetch('https://googleads.googleapis.com/$discovery/rest?version=v19');
    const text = await r.text();
    results.googleads_discovery = { status: r.status, is_json: text.trim().startsWith('{'), body_preview: text.substring(0, 200) };
  } catch(e) {
    results.googleads_discovery = { error: e.message };
  }

  // Test 3 — Get an access token
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
        client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
        refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
        grant_type:    'refresh_token'
      })
    });
    const tokenData = await tokenRes.json();
    results.token = {
      status: tokenRes.status,
      has_access_token: !!tokenData.access_token,
      token_type: tokenData.token_type,
      error: tokenData.error || null
    };

    // Test 4 — Hit the actual API with the token
    if (tokenData.access_token) {
      const customerId = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
      const apiRes = await fetch(
        `https://googleads.googleapis.com/v20/customers/${customerId}:uploadClickConversions`,
        {
          method: 'POST',
          headers: {
            'Authorization':     `Bearer ${tokenData.access_token}`,
            'developer-token':   process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
            'login-customer-id': '6046238343',
            'Content-Type':      'application/json'
          },
          body: JSON.stringify({
            conversions: [{
              gclid:           'test_gclid_12345',
              conversionAction: `customers/${customerId}/conversionActions/${process.env.GOOGLE_ADS_HIGH_POTENTIAL_ACTION_ID}`,
              conversionDateTime: '2026-04-18 12:00:00+00:00',
              conversionValue:  1.0,
              currencyCode:    'GBP'
            }],
            partialFailure: true,
            validateOnly:   true  // validateOnly = true means Google validates but doesn't record
          })
        }
      );
      const rawText = await apiRes.text();
      results.api_call = {
        status: apiRes.status,
        body:   rawText.substring(0, 500)
      };
    }
  } catch(e) {
    results.token = { error: e.message };
  }

  console.log('Test results:', JSON.stringify(results, null, 2));
  return res.status(200).json(results);
};
