// ============================================================
//  Google's own verdict on our conversion uploads.
//
//  offline_conversion_upload_client_summary is the API face of the
//  "Offline conversion data issues" banner in the Ads UI: per upload
//  client, Google reports total events, success rate, and named alerts
//  (e.g. CONVERSION_NOT_FOUND at 100%). Nothing polled it before, which
//  is why the July 2026 transaction-id breakage was only spotted when
//  Alex saw the banner himself weeks in.
//
//  Read-only. One call per Ads account; Stay Luxe is a child of the same
//  MCC so the same OAuth credentials serve both.
// ============================================================

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

// Returns { status, clients: [{ client, status, total, successRate, lastUpload, alerts }] }
// or null when the account id is not configured. status is the worst client
// status: NEEDS_ATTENTION beats EXCELLENT.
async function uploadDiagnostics (customerId) {
  const cid = (customerId || '').replace(/-/g, '').trim();
  if (!cid) return null;

  const tok   = await getAccessToken();
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
      query: `SELECT offline_conversion_upload_client_summary.client,
                     offline_conversion_upload_client_summary.status,
                     offline_conversion_upload_client_summary.total_event_count,
                     offline_conversion_upload_client_summary.successful_event_count,
                     offline_conversion_upload_client_summary.success_rate,
                     offline_conversion_upload_client_summary.last_upload_date_time,
                     offline_conversion_upload_client_summary.alerts
              FROM offline_conversion_upload_client_summary`
    })
  });
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error).slice(0, 200));

  const clients = (d.results || []).map(row => {
    const s = row.offlineConversionUploadClientSummary || {};
    return {
      client:      s.client || 'UNKNOWN',
      status:      s.status || 'UNKNOWN',
      total:       Number(s.totalEventCount || 0),
      successRate: s.successRate != null ? Math.round(s.successRate * 100) : null,
      lastUpload:  s.lastUploadDateTime || null,
      alerts: (s.alerts || []).map(a => ({
        error: Object.values(a.error || {})[0] || 'unknown error',
        pct:   a.errorPercentage != null ? Math.round(a.errorPercentage * 100) : null
      }))
    };
  });

  const RANK = { NEEDS_ATTENTION: 3, NEEDS_REVIEW: 2, GOOD: 1, EXCELLENT: 0, UNKNOWN: 1 };
  const status = clients.reduce((worst, c) =>
    (RANK[c.status] ?? 1) > (RANK[worst] ?? 1) ? c.status : worst, 'EXCELLENT');

  return { status, clients };
}

module.exports = { uploadDiagnostics };
