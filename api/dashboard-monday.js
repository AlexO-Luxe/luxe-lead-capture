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
      fetchAllItems(BOOKINGS_BOARD, ['date9', 'numeric_mm1ge9h4', 'lookup_mkyehzea', 'mirror64', 'lookup_mkxtxk48', 'text_mm1c3b5w', 'mirror21__1', 'mirror988__1'], true)
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
    body: JSON.stringify({ query })
  });
  const data = await r.json();
  if (data.errors) throw new Error('Monday API: ' + JSON.stringify(data.errors));
  return data;
}

async function fetchAllItems(boardId, columnIds, includeGroup = false) {
  const cols = columnIds.map(c => `"${c}"`).join(', ');
  const groupField = includeGroup ? 'group { title }' : '';
  let allItems = [], cursor = null;
  do {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const query = `query {
      boards(ids: [${boardId}]) {
        items_page(limit: 500${cursorArg}) {
          cursor
          items { id name created_at ${groupField} column_values(ids: [${cols}]) { id text value } }
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

  // Non-spam leads for conversion rate denominator
  const nonSpam = filtered.filter(item => {
    const cols = colMap(item);
    return (cols['status'] || '').trim() !== 'Spam!';
  });

  const bySource = {}, byChannel = {}, byCity = {}, byCampaign = {};
  filtered.forEach(item => {
    const cols = colMap(item);
    const source   = cols['color_mkxk8y67']   || 'Unknown';
    const channel  = cols['dropdown_mkxkfbff'] || 'Unknown';
    const city     = normaliseCity(cols['text8']);
    const campaign = cols['text_mm1c3b5w']     || 'Unknown';
    bySource[source]     = (bySource[source]     || 0) + 1;
    byChannel[channel]   = (byChannel[channel]   || 0) + 1;
    byCity[city]         = (byCity[city]         || 0) + 1;
    byCampaign[campaign] = (byCampaign[campaign] || 0) + 1;
  });

  return {
    total:       filtered.length,
    nonSpamTotal: nonSpam.length,
    bySource:    sortDesc(bySource),
    byChannel:   sortDesc(byChannel),
    byCity:      sortDesc(byCity),
    byCampaign:  sortDesc(byCampaign)
  };
}

function processBookings(items, startDate, endDate) {
  // Exclude Pending, Cancelled, Lost groups
  const eligible = items.filter(item => {
    const groupTitle = item.group?.title || '';
    return !EXCLUDED_BOOKING_GROUPS.includes(groupTitle);
  });

  const filtered = eligible.filter(item => {
    const cols = colMap(item);
    const d = new Date(cols['date9']);
    return !isNaN(d) && d >= startDate && d < endDate;
  });

  console.log(`Bookings: ${items.length} total, ${eligible.length} after group filter, ${filtered.length} in date range ${startDate.toISOString()} - ${endDate.toISOString()}`);
  console.log('Date9 sample:', JSON.stringify(eligible.slice(0,5).map(item => ({ name: item.name, group: item.group?.title, date9: colMap(item)['date9'] }))));
  // Debug: log what source values are coming back
  const sourceValues = filtered.slice(0, 10).map(item => {
    const cols = colMap(item);
    return { name: item.name, source: cols['lookup_mkxtxk48'], gclid: cols['mirror21__1'] };
  });
  console.log('Booking source sample:', JSON.stringify(sourceValues));
  console.log('Booking campaign sample:', JSON.stringify(filtered.slice(0,5).map(item => {
    const cols = colMap(item);
    return { name: item.name, campaign988: cols['mirror988__1'], campaignText: cols['text_mm1c3b5w'], rev: cols['numeric_mm1ge9h4'] };
  })));

  let totalRevenue = 0;
  let ppcCount = 0;
  let ppcRevenue = 0;
  const byChannel = {}, byCity = {}, bySource = {}, byCampaign = {};

  filtered.forEach(item => {
    const cols     = colMap(item);
    const channel  = cols['lookup_mkyehzea'] || 'Unknown';
    const city     = normaliseCity(cols['mirror64']);
    const source   = cols['lookup_mkxtxk48'] || 'Unknown';
    const campaign = cols['mirror988__1'] || cols['text_mm1c3b5w'] || 'Unknown';
    const rev      = parseFloat(cols['numeric_mm1ge9h4']) || 0;

    // PPC booking = mirror988__1 (PPC campaign mirror) has a value
    const ppcCampaign = cols['mirror988__1'] || '';
    const isPPC = ppcCampaign.trim().length > 0;
    if (isPPC) { ppcCount++; ppcRevenue += rev; }

    [byChannel, byCity, bySource, byCampaign].forEach((obj, i) => {
      const key = [channel, city, source, campaign][i];
      if (!obj[key]) obj[key] = { count: 0, revenue: 0 };
      obj[key].count++;
      obj[key].revenue += rev;
    });
    totalRevenue += rev;
  });

  return {
    total:        filtered.length,
    totalRevenue: Math.round(totalRevenue),
    ppcCount,
    ppcRevenue:   Math.round(ppcRevenue),
    byChannel:    sortByRevDesc(byChannel),
    byCity:       sortByRevDesc(byCity),
    bySource:     sortByRevDesc(bySource),
    byCampaign:   sortByRevDesc(byCampaign)
  };
}

function sortDesc(obj) {
  return Object.entries(obj).sort((a,b)=>b[1]-a[1]).reduce((acc,[k,v])=>{acc[k]=v;return acc;},{});
}
function sortByRevDesc(obj) {
  return Object.entries(obj).sort((a,b)=>b[1].revenue-a[1].revenue).reduce((acc,[k,v])=>{acc[k]=v;return acc;},{});
}
