// ============================================================
//  Student Luxe — Attribution Dashboard API
//  GET /api/dashboard-attribution?days=7
//  GET /api/dashboard-attribution?mondayId=12345
// ============================================================
//
//  Joins recent Monday leads with their Vercel KV session record
//  so the dashboard can show first-touch vs last-touch attribution,
//  device fingerprint, full multi-touch path.
// ============================================================

const MONDAY_API   = 'https://api.monday.com/v2';
const LEADS_BOARD  = 2171015719;

const {
  findSessionByMondayId,
  findSessionByEmail,
  classifyTouch
} = require('./_attribution.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.query.mondayId) {
      const session = await findSessionByMondayId(req.query.mondayId);
      return res.status(200).json({ session: session || null });
    }

    const days  = Math.min(parseInt(req.query.days || '7', 10), 30);
    const since = new Date(Date.now() - days * 864e5);

    const leads = await fetchRecentLeads(since);

    // Parallel KV lookups, capped to keep response < 3s
    const enriched = await Promise.all(
      leads.slice(0, 200).map(async lead => {
        let session = await findSessionByMondayId(lead.id);
        if (!session && lead.email) session = await findSessionByEmail(lead.email);
        return {
          id:        lead.id,
          name:      lead.name,
          email:     lead.email,
          createdAt: lead.createdAt,
          city:      lead.city,
          source:    lead.source,
          campaign:  lead.campaign,
          first:     session?.first || null,
          last:      session?.last  || null,
          touches:   (session?.touches || []).length,
          firstChannel: session?.first ? classifyTouch(session.first) : null,
          lastChannel:  session?.last  ? classifyTouch(session.last)  : null
        };
      })
    );

    return res.status(200).json({
      windowDays: days,
      total:      leads.length,
      enriched:   enriched.length,
      leads:      enriched
    });
  } catch (err) {
    console.error('dashboard-attribution error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

async function fetchRecentLeads(since) {
  // Pull last 500 leads, filter by created_at >= since.
  const query = `query {
    boards(ids: [${LEADS_BOARD}]) {
      items_page(limit: 500) {
        items {
          id name created_at
          column_values(ids: ["email", "color_mkxk8y67", "text_mm1c3b5w", "text8"]) {
            id text
          }
        }
      }
    }
  }`;

  const r = await fetch(MONDAY_API, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
    body:    JSON.stringify({ query })
  });
  const data = await r.json();
  if (data.errors) throw new Error('Monday: ' + JSON.stringify(data.errors));

  const items = data?.data?.boards?.[0]?.items_page?.items || [];
  return items
    .filter(i => new Date(i.created_at) >= since)
    .map(i => {
      const cols = {};
      (i.column_values || []).forEach(c => { cols[c.id] = c.text || ''; });
      return {
        id:        i.id,
        name:      i.name,
        createdAt: i.created_at,
        email:     cols.email     || '',
        source:    cols.color_mkxk8y67 || '',
        campaign:  cols.text_mm1c3b5w  || '',
        city:      cols.text8     || ''
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
