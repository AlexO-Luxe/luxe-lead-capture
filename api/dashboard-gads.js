// ============================================================
//  Student Luxe — Dashboard: Google Ads Data
//  GET /api/dashboard-gads?month=2026-04&prevMonth=2026-03
// ============================================================

const CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
const MCC_ID      = '6046238343';

// ── City mapping from campaign name ──────────────────────────
// All campaigns not listed default to 'London'
const CAMPAIGN_CITY = {
  'new-york-os':          'New York',
  'paris-os':             'Paris',
  'PARIS - from OS _Experiment': 'Paris',
  'cambridge-os':         'Cambridge',
  'lse-summer-uni-campus':'London',
  'lse-summer-all-us':    'London',
  'lse-summer-perf-max':  'London',
  'LSE SUMMER - All US _Experiment': 'London',
};
function cityFromCampaign(name) {
  if (!name) return 'London';
  // Exact match first
  if (CAMPAIGN_CITY[name]) return CAMPAIGN_CITY[name];
  // Pattern match
  const n = name.toLowerCase();
  if (n.includes('new-york') || n.includes('new york')) return 'New York';
  if (n.includes('paris'))      return 'Paris';
  if (n.includes('cambridge'))  return 'Cambridge';
  if (n.includes('madrid'))     return 'Madrid';
  if (n.includes('edinburgh'))  return 'Edinburgh';
  if (n.includes('milan'))      return 'Milan';
  // Default London (core-luxe, rentals, jf_*, brand etc.)
  return 'London';
}

// ── Monthly budgets ───────────────────────────────────────────
const MONTHLY_BUDGETS = {
  '01': 46000, '02': 45000, '03': 55000, '04': 55000,
  '05': 55000, '06': 60000, '07': 65000, '08': 65000,
  '09': 65000, '10': 29000, '11': 28000, '12': 28000
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { month, prevMonth } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month param required, format YYYY-MM' });
  }

  try {
    const token = await getAccessToken();

    function dateRange(m) {
      const [y, mo] = m.split('-').map(Number);
      const last = new Date(y, mo, 0).getDate();
      return {
        start: `${y}-${String(mo).padStart(2,'0')}-01`,
        end:   `${y}-${String(mo).padStart(2,'0')}-${String(last).padStart(2,'0')}`
      };
    }

    const cur = dateRange(month);
    const [accountSummary, campaigns] = await Promise.all([
      queryAccountSummary(token, cur.start, cur.end),
      queryCampaigns(token, cur.start, cur.end)
    ]);

    const monStr = month.split('-')[1];
    const budget = MONTHLY_BUDGETS[monStr] || null;

    const result = { month, budget, accountSummary, campaigns };

    if (prevMonth && /^\d{4}-\d{2}$/.test(prevMonth)) {
      const prev = dateRange(prevMonth);
      const [prevSummary] = await Promise.all([
        queryAccountSummary(token, prev.start, prev.end)
      ]);
      result.prevMonth = prevMonth;
      result.prevAccountSummary = prevSummary;
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('Dashboard GAds error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

async function getAccessToken() {
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
  if (!d.access_token) throw new Error('Token failed: ' + JSON.stringify(d));
  return d.access_token;
}

async function gadsQuery(token, gaql) {
  const url = `https://googleads.googleapis.com/v20/customers/${CUSTOMER_ID}/googleAds:search`;
  const r = await fetch(url, {
    method: 'POST',
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
    throw new Error('Non-JSON: ' + text.substring(0, 200));
  }
  const data = JSON.parse(text);
  if (data.error) throw new Error('GAds: ' + JSON.stringify(data.error));
  return data.results || [];
}

async function queryAccountSummary(token, startStr, endStr) {
  const results = await gadsQuery(token, `
    SELECT
      metrics.cost_micros,
      metrics.clicks,
      metrics.impressions,
      metrics.conversions,
      metrics.conversions_value
    FROM customer
    WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
  `);

  let costMicros = 0, clicks = 0, impressions = 0, conversions = 0, conversionsValue = 0;
  results.forEach(r => {
    costMicros       += r.metrics?.costMicros       || 0;
    clicks           += r.metrics?.clicks           || 0;
    impressions      += r.metrics?.impressions      || 0;
    conversions      += r.metrics?.conversions      || 0;
    conversionsValue += r.metrics?.conversionsValue || 0;
  });

  const spend = costMicros / 1_000_000;
  const ctr   = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const cpl   = conversions > 0 ? spend / conversions : 0;
  const roas  = spend > 0 ? conversionsValue / spend : 0;

  return {
    spend:            r2(spend),
    clicks,
    impressions,
    ctr:              r2(ctr),
    conversions:      r1(conversions),
    conversionsValue: r2(conversionsValue),
    cpl:              r2(cpl),
    roas:             r2(roas)
  };
}

async function queryCampaigns(token, startStr, endStr) {
  const results = await gadsQuery(token, `
    SELECT
      campaign.id,
      campaign.name,
      metrics.cost_micros,
      metrics.clicks,
      metrics.impressions,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
      AND metrics.impressions > 0
    ORDER BY metrics.cost_micros DESC
    LIMIT 30
  `);

  const map = {};
  results.forEach(r => {
    const id   = r.campaign?.id;
    const name = r.campaign?.name || 'Unknown';
    if (!map[id]) map[id] = { id, name, costMicros:0, clicks:0, impressions:0, conversions:0, conversionsValue:0 };
    map[id].costMicros       += r.metrics?.costMicros       || 0;
    map[id].clicks           += r.metrics?.clicks           || 0;
    map[id].impressions      += r.metrics?.impressions      || 0;
    map[id].conversions      += r.metrics?.conversions      || 0;
    map[id].conversionsValue += r.metrics?.conversionsValue || 0;
  });

  return Object.values(map).map(c => {
    const spend = c.costMicros / 1_000_000;
    const ctr   = c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0;
    const cpc  = c.clicks > 0 ? spend / c.clicks : null;
    const roas  = spend > 0 && c.conversionsValue > 0 ? c.conversionsValue / spend : null;
    return {
      id:               c.id,
      name:             c.name,
      city:             cityFromCampaign(c.name),
      spend:            r2(spend),
      clicks:           Math.round(c.clicks),
      impressions:      c.impressions,
      ctr:              r2(ctr),
      cpc:              cpc ? r2(cpc) : null,
      conversions:      r1(c.conversions),
      conversionsValue: r2(c.conversionsValue),
      roas:             roas ? r2(roas) : null
    };
  }).sort((a,b) => b.spend - a.spend);
}

function r2(n) { return Math.round(n * 100) / 100; }
function r1(n) { return Math.round(n * 10)  / 10;  }
