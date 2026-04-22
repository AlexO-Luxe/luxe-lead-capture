// ============================================================
//  Student Luxe — Dashboard: Monday Data
//  GET /api/dashboard-monday?month=2026-04
//  Returns leads + bookings data for a given month
// ============================================================

const MONDAY_API     = 'https://api.monday.com/v2';
const LEADS_BOARD    = 2171015719;
const BOOKINGS_BOARD = 2171015589;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { month } = req.query; // e.g. "2026-04"
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month param required, format YYYY-MM' });
  }

  const [year, mon] = month.split('-').map(Number);
  const startDate = new Date(year, mon - 1, 1);
  const endDate   = new Date(year, mon, 1); // exclusive

  try {
    const [leads, bookings] = await Promise.all([
      fetchLeads(startDate, endDate),
      fetchBookings(startDate, endDate)
    ]);

    return res.status(200).json({ month, leads, bookings });
  } catch (err) {
    console.error('Dashboard Monday error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Monday query helper ───────────────────────────────────────
async function mondayQuery(query) {
  const res = await fetch(MONDAY_API, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': process.env.MONDAY_API_KEY
    },
    body: JSON.stringify({ query })
  });
  const data = await res.json();
  if (data.errors) throw new Error('Monday API: ' + JSON.stringify(data.errors));
  return data;
}

// ── Paginate all items from a board ──────────────────────────
async function fetchAllItems(boardId, columnIds) {
  const cols = columnIds.map(c => `"${c}"`).join(', ');
  let allItems = [];
  let cursor = null;

  do {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const query = `
      query {
        boards(ids: [${boardId}]) {
          items_page(limit: 500${cursorArg}) {
            cursor
            items {
              id
              name
              created_at
              column_values(ids: [${cols}]) {
                id
                text
                value
              }
            }
          }
        }
      }
    `;
    const data = await mondayQuery(query);
    const page = data?.data?.boards?.[0]?.items_page;
    allItems = allItems.concat(page?.items || []);
    cursor = page?.cursor || null;
  } while (cursor);

  return allItems;
}

// ── Parse column values into a map ───────────────────────────
function colMap(item) {
  const map = {};
  (item.column_values || []).forEach(c => { map[c.id] = c.text || ''; });
  return map;
}

// ── LEADS ────────────────────────────────────────────────────
async function fetchLeads(startDate, endDate) {
  const items = await fetchAllItems(LEADS_BOARD, [
    'color_mkxk8y67',   // Lead source (PPC/SEO/Socials)
    'dropdown_mkxkfbff' // Channel / How
  ]);

  const filtered = items.filter(item => {
    const created = new Date(item.created_at);
    return created >= startDate && created < endDate;
  });

  // Aggregate by source
  const bySource  = {};
  const byChannel = {};

  filtered.forEach(item => {
    const cols    = colMap(item);
    const source  = cols['color_mkxk8y67']   || 'Unknown';
    const channel = cols['dropdown_mkxkfbff'] || 'Unknown';

    bySource[source]   = (bySource[source]   || 0) + 1;
    byChannel[channel] = (byChannel[channel] || 0) + 1;
  });

  return {
    total:     filtered.length,
    bySource:  sortDesc(bySource),
    byChannel: sortDesc(byChannel)
  };
}

// ── BOOKINGS ─────────────────────────────────────────────────
async function fetchBookings(startDate, endDate) {
  const items = await fetchAllItems(BOOKINGS_BOARD, [
    'date9',            // Confirmed date
    'formula2',         // Revenue
    'lookup_mkyehzea'   // How (connected from leads board)
  ]);

  const filtered = items.filter(item => {
    const cols        = colMap(item);
    const confirmedAt = cols['date9'];
    if (!confirmedAt) return false;
    const d = new Date(confirmedAt);
    return d >= startDate && d < endDate;
  });

  // Aggregate
  const byChannel = {};
  let totalRevenue = 0;

  filtered.forEach(item => {
    const cols    = colMap(item);
    const channel = cols['lookup_mkyehzea'] || 'Unknown';
    const rev     = parseFloat(cols['formula2']) || 0;

    byChannel[channel] = byChannel[channel] || { count: 0, revenue: 0 };
    byChannel[channel].count++;
    byChannel[channel].revenue += rev;
    totalRevenue += rev;
  });

  // Sort by count desc
  const byChannelSorted = Object.entries(byChannel)
    .sort((a, b) => b[1].count - a[1].count)
    .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});

  return {
    total:       filtered.length,
    totalRevenue: Math.round(totalRevenue),
    byChannel:   byChannelSorted
  };
}

function sortDesc(obj) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});
}
