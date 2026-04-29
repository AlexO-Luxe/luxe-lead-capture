// ============================================================
//  Student Luxe — Dashboard: Monday Data
//  GET /api/dashboard-monday?month=2026-04&prevMonth=2026-03
// ============================================================

const MONDAY_API     = 'https://api.monday.com/v2';
const LEADS_BOARD    = 2171015719;
const BOOKINGS_BOARD = 2171015589;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { month, prevMonth } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month param required, format YYYY-MM' });
  }

  function monthRange(m) {
    const [y, mo] = m.split('-').map(Number);
    return { start: new Date(y, mo - 1, 1), end: new Date(y, mo, 1) };
  }

  try {
    const [leadsItems, bookingsItems] = await Promise.all([
      fetchAllItems(LEADS_BOARD,    ['color_mkxk8y67', 'dropdown_mkxkfbff', 'text8', 'text_mm1c3b5w', 'status']),
      fetchAllItems(BOOKINGS_BOARD, ['date9', 'numeric_mm1ge9h4', 'formula1', 'people_1'], true, true)
    ]);

    const cur  = monthRange(month);
    const prev = prevMonth && /^\d{4}-\d{2}$/.test(prevMonth) ? monthRange(prevMonth) : null;

    const result = { month, current: processMonth(leadsItems, bookingsItems, cur.start, cur.end) };
    if (prev) {
      result.prevMonth = prevMonth;
      result.previous  = processMonth(leadsItems, bookingsItems, prev.start, prev.end);
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('Dashboard Monday error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

function processMonth(leadsItems, bookingsItems, startDate, endDate) {
  return {
    leads:    processLeads(leadsItems, startDate, endDate),
    bookings: processBookings(bookingsItems, startDate, endDate)
  };
}

async function mondayQuery(query) {
  const r = await fetch(MONDAY_API, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
    body:    JSON.stringify({ query })
  });
  const data = await r.json();
  if (data.errors) throw new Error('Monday API: ' + JSON.stringify(data.errors));
  return data;
}

async function fetchAllItems(boardId, columnIds, includeGroup = false, includeLinked = false) {
  const cols = columnIds.map(c => `"${c}"`).join(', ');
  const groupField = includeGroup ? 'group { title }' : '';
  let allItems = [], cursor = null;
  do {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const query = `query {
      boards(ids: [${boardId}]) {
        items_page(limit: 500${cursorArg}) {
          cursor
          items {
            id name created_at ${groupField}
            column_values(ids: [${cols}]) { id text value }
            ${includeLinked ? `relation: column_values(ids: ["link_to_leads26"]) {
              id
              ... on BoardRelationValue {
                linked_items {
                  id
                  column_values(ids: ["color_mkxk8y67", "dropdown_mkxkfbff", "text8", "text_mm1c3b5w"]) {
                    id text
                  }
                }
              }
            }` : ''}
          }
        }
      }
    }`;
    const data = await mondayQuery(query);
    const page = data?.data?.boards?.[0]?.items_page;
    allItems = allItems.concat(page?.items || []);
    cursor = page?.cursor || null;
  } while (cursor);
  return allItems;
}

function colMap(item) {
  const map = {};
  (item.column_values || []).forEach(c => { map[c.id] = c.text || ''; });
  return map;
}

const CITY_DISPLAY = {
  'london':'London','new-york':'New York','new york':'New York',
  'paris':'Paris','cambridge':'Cambridge','madrid':'Madrid',
  'edinburgh':'Edinburgh','milan':'Milan','amsterdam':'Amsterdam',
  'barcelona':'Barcelona','lisbon':'Lisbon','boston':'Boston',
  'chicago':'Chicago','washington':'Washington DC','philadelphia':'Philadelphia'
};
function normaliseCity(raw) {
  if (!raw) return 'Unknown';
  const key = raw.toLowerCase().trim();
  return CITY_DISPLAY[key] || raw;
}

const EXCLUDED_BOOKING_GROUPS = ['Pending Bookings', 'Cancelled Bookings', 'Lost Bookings'];

function processLeads(items, startDate, endDate) {
  const filtered = items.filter(item => {
    const d = new Date(item.created_at);
    return d >= startDate && d < endDate;
  });

  const nonSpam = filtered.filter(item => {
    const cols = colMap(item);
    return (cols['status'] || '').trim() !== 'Spam!';
  });

  // Unqualified leads
  const unqualified = filtered.filter(item => {
    const s = (colMap(item)['status'] || '').trim();
    return s === 'Unqualified Lead';
  });

  const bySource = {}, byChannel = {}, byCity = {}, byCampaign = {};
  const byCitySource = {};

  filtered.forEach(item => {
    const cols     = colMap(item);
    const source   = cols['color_mkxk8y67']   || 'Unknown';
    const channel  = cols['dropdown_mkxkfbff'] || 'Unknown';
    const city     = normaliseCity(cols['text8']);
    const campaign = cols['text_mm1c3b5w']     || 'Unknown';

    bySource[source]     = (bySource[source]     || 0) + 1;
    byChannel[channel]   = (byChannel[channel]   || 0) + 1;
    byCity[city]         = (byCity[city]         || 0) + 1;
    byCampaign[campaign] = (byCampaign[campaign] || 0) + 1;

    if (!byCitySource[city]) byCitySource[city] = { PPC:0, SEO:0, Other:0 };
    const bucket = source === 'PPC' ? 'PPC' : source === 'SEO' ? 'SEO' : 'Other';
    byCitySource[city][bucket]++;
  });

  return {
    total:            filtered.length,
    nonSpamTotal:     nonSpam.length,
    unqualifiedTotal: unqualified.length,
    bySource:     sortDesc(bySource),
    byChannel:    sortDesc(byChannel),
    byCity:       sortDesc(byCity),
    byCampaign:   sortDesc(byCampaign),
    byCitySource
  };
}

function processBookings(items, startDate, endDate) {
  const eligible = items.filter(item => {
    const groupTitle = item.group?.title || '';
    return !EXCLUDED_BOOKING_GROUPS.includes(groupTitle);
  });

  const filtered = eligible.filter(item => {
    const cols = colMap(item);
    const d    = new Date(cols['date9']);
    return !isNaN(d) && d >= startDate && d < endDate;
  });

  let totalRevenue = 0, ppcCount = 0, ppcRevenue = 0;
  const byChannel = {}, byCity = {}, bySource = {}, byCampaign = {};
  const byCitySource = {};

  filtered.forEach(item => {
    const cols = colMap(item);
    const rev  = parseFloat(cols['numeric_mm1ge9h4']) || 0;

    const relationCol = (item.relation || []).find(cv => cv.id === 'link_to_leads26');
    const linkedItems = relationCol?.linked_items || [];
    const lead        = linkedItems[0];

    let source = 'Unknown', channel = 'Unknown', city = 'Unknown', campaign = 'Unknown';
    if (lead) {
      const lc   = {};
      (lead.column_values || []).forEach(c => { lc[c.id] = c.text || ''; });
      source   = lc['color_mkxk8y67']   || 'Unknown';
      channel  = lc['dropdown_mkxkfbff'] || 'Unknown';
      city     = normaliseCity(lc['text8']);
      campaign = lc['text_mm1c3b5w']    || 'Unknown';
    }

    const isPPC = source === 'PPC';
    const isSEO = source === 'SEO';
    if (isPPC) { ppcCount++; ppcRevenue += rev; }

    if (!byCitySource[city]) byCitySource[city] = {};
    if (!byCitySource[city][source]) byCitySource[city][source] = { count:0, revenue:0 };
    byCitySource[city][source].count++;
    byCitySource[city][source].revenue += rev;

    if (!byCitySource[city]._PPC)   byCitySource[city]._PPC   = { count:0, revenue:0 };
    if (!byCitySource[city]._SEO)   byCitySource[city]._SEO   = { count:0, revenue:0 };
    if (!byCitySource[city]._Other) byCitySource[city]._Other = { count:0, revenue:0 };
    const bucket = isPPC ? '_PPC' : isSEO ? '_SEO' : '_Other';
    byCitySource[city][bucket].count++;
    byCitySource[city][bucket].revenue += rev;

    [byChannel, byCity, bySource].forEach((obj, i) => {
      const key = [channel, city, source][i];
      if (!obj[key]) obj[key] = { count:0, revenue:0 };
      obj[key].count++;
      obj[key].revenue += rev;
    });

    if (isPPC && campaign !== 'Unknown') {
      if (!byCampaign[campaign]) byCampaign[campaign] = { count:0, revenue:0 };
      byCampaign[campaign].count++;
      byCampaign[campaign].revenue += rev;
    }

    totalRevenue += rev;
  });

  const top5Bookings = filtered
    .map(item => {
      const cols = colMap(item);
      return { name: item.name, revenue: parseFloat(cols['numeric_mm1ge9h4']) || 0 };
    })
    .filter(b => b.revenue > 0)
    .sort((a,b) => b.revenue - a.revenue)
    .slice(0, 5);

  // Avg nights (formula1 column)
  const nightsValues = filtered
    .map(item => parseFloat(colMap(item)['formula1']) || 0)
    .filter(n => n > 0);
  const avgNights = nightsValues.length > 0
    ? Math.round(nightsValues.reduce((a,b) => a+b, 0) / nightsValues.length)
    : null;

  // Top salesperson by revenue (people_1 column)
  const salesRev = {};
  filtered.forEach(item => {
    const cols = colMap(item);
    const name = (cols['people_1'] || '').trim();
    const rev  = parseFloat(cols['numeric_mm1ge9h4']) || 0;
    if (name) salesRev[name] = (salesRev[name] || 0) + rev;
  });
  const topSalesperson = Object.keys(salesRev).length > 0
    ? Object.entries(salesRev).sort((a,b) => b[1]-a[1])[0]
    : null; // [name, totalRevenue]

  return {
    total:          filtered.length,
    totalRevenue:   Math.round(totalRevenue),
    ppcCount,
    ppcRevenue:     Math.round(ppcRevenue),
    top5Bookings,
    avgNights,
    topSalesperson,
    byChannel:      sortByRevDesc(byChannel),
    byCity:         sortByRevDesc(byCity),
    bySource:       sortByRevDesc(bySource),
    byCampaign:     sortByRevDesc(byCampaign),
    byCitySource
  };
}

function sortDesc(obj) {
  return Object.entries(obj).sort((a,b)=>b[1]-a[1]).reduce((acc,[k,v])=>{acc[k]=v;return acc;},{});
}
function sortByRevDesc(obj) {
  return Object.entries(obj).sort((a,b)=>b[1].revenue-a[1].revenue).reduce((acc,[k,v])=>{acc[k]=v;return acc;},{});
}
