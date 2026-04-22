// ============================================================
//  Student Luxe — Dashboard: Google Ads Data
//  GET /api/dashboard-gads?month=2026-04
//  Returns spend, clicks, CTR, CPE at account + campaign level
// ============================================================

const CUSTOMER_ID = process.env.GOOGLE_ADS_CUSTOMER_ID?.replace(/-/g, '');
const MCC_ID      = '6046238343';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { month } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month param required, format YYYY-MM' });
  }

  const [year, mon] = month.split('-').map(Number);
  const startStr = `${year}-${String(mon).padStart(2,'0')}-01`;
  const lastDay  = new Date(year, mon, 0).getDate();
  const endStr   = `${year}-${String(mon).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

  try {
    const token = await getAccessToken();

    const [accountSummary, campaigns] = await Promise.all([
      queryAccountSummary(token, startStr, endStr),
      queryCampaigns(token, startStr, endStr)
    ]);

    return res.status(200).json({ month, accountSummary, campaigns });
  } catch (err) {
    console.error('Dashboard GAds error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── OAuth token ───────────────────────────────────────────────
async function getAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(d));
  return d.access_token;
}

// ── Google Ads query helper ───────────────────────────────────
async function gadsQuery(token, gaql) {
  const url = `https://googleads.googleapis.com/v20/customers/${CUSTOMER_ID}/googleAds:search`;
  const r = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization':     `Bearer ${token}`,
      'developer-token':   process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'login-customer-id': MCC_ID,
      'Content-Type':      'application/json'
    },
    body: JSON.stringify({ query: gaql })
  });
  const text = await r.text();
  if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) {
    throw new Error('Non-JSON response: ' + text.substring(0, 200));
  }
  const data = JSON.parse(text);
  if (data.error) throw new Error('GAds API error: ' + JSON.stringify(data.error));
  return data.results || [];
}

// ── Account-level summary ─────────────────────────────────────
async function queryAccountSummary(token, startStr, endStr) {
  const gaql = `
    SELECT
      metrics.cost_micros,
      metrics.clicks,
      metrics.impressions,
      metrics.ctr,
      metrics.conversions,
      metrics.cost_per_conversion,
      metrics.conversions_value
    FROM customer
    WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
  `;

  const results = await gadsQuery(token, gaql);
  if (!results.length) return null;

  // Sum across rows (there may be multiple date segments)
  let costMicros = 0, clicks = 0, impressions = 0, conversions = 0, conversionsValue = 0;
  results.forEach(r => {
    costMicros      += r.metrics?.costMicros      || 0;
    clicks          += r.metrics?.clicks          || 0;
    impressions     += r.metrics?.impressions     || 0;
    conversions     += r.metrics?.conversions     || 0;
    conversionsValue += r.metrics?.conversionsValue || 0;
  });

  const spend  = costMicros / 1_000_000;
  const ctr    = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const cpe    = conversions > 0 ? spend / conversions : 0;
  const roas   = spend > 0 ? conversionsValue / spend : 0;

  return {
    spend:            Math.round(spend * 100) / 100,
    clicks,
    impressions,
    ctr:              Math.round(ctr * 100) / 100,
    conversions:      Math.round(conversions * 10) / 10,
    conversionsValue: Math.round(conversionsValue * 100) / 100,
    cpe:              Math.round(cpe * 100) / 100,
    roas:             Math.round(roas * 100) / 100
  };
}

// ── Campaign-level breakdown ──────────────────────────────────
async function queryCampaigns(token, startStr, endStr) {
  const gaql = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      metrics.cost_micros,
      metrics.clicks,
      metrics.impressions,
      metrics.ctr,
      metrics.conversions,
      metrics.cost_per_conversion,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
      AND metrics.impressions > 0
    ORDER BY metrics.cost_micros DESC
    LIMIT 25
  `;

  const results = await gadsQuery(token, gaql);

  // Aggregate by campaign (multiple date rows per campaign)
  const map = {};
  results.forEach(r => {
    const id   = r.campaign?.id;
    const name = r.campaign?.name || 'Unknown';
    if (!map[id]) {
      map[id] = { id, name, costMicros: 0, clicks: 0, impressions: 0, conversions: 0, conversionsValue: 0 };
    }
    map[id].costMicros       += r.metrics?.costMicros       || 0;
    map[id].clicks           += r.metrics?.clicks           || 0;
    map[id].impressions      += r.metrics?.impressions      || 0;
    map[id].conversions      += r.metrics?.conversions      || 0;
    map[id].conversionsValue += r.metrics?.conversionsValue || 0;
  });

  return Object.values(map)
    .map(c => {
      const spend = c.costMicros / 1_000_000;
      const ctr   = c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0;
      const roas  = spend > 0 ? c.conversionsValue / spend : null;
      return {
        id:               c.id,
        name:             c.name,
        spend:            Math.round(spend * 100) / 100,
        clicks:           c.clicks,
        impressions:      c.impressions,
        ctr:              Math.round(ctr * 100) / 100,
        conversions:      Math.round(c.conversions * 10) / 10,
        conversionsValue: Math.round(c.conversionsValue * 100) / 100,
        roas:             roas ? Math.round(roas * 100) / 100 : null
      };
    })
    .sort((a, b) => b.spend - a.spend);
}
