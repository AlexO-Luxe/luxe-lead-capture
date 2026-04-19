// ============================================================
//  Student Luxe — WhatsApp Click Lead Capture
//  Deploy to: /api/submit-whatsapp.js
//
//  Called when a visitor clicks any wa.me link on the site.
//  Creates a new lead in Monday.com Leads board with UTM
//  and gclid data captured from first-party cookies.
//
//  Payload expected:
//  {
//    gclid, utm_campaign, utm_term, utm_matchtype,
//    landing_page, last_page, page_path, timestamp
//  }
//
//  Environment variables required:
//    MONDAY_API_KEY
// ============================================================

const MONDAY_API   = 'https://api.monday.com/v2';
const LEADS_BOARD  = '2171015719';

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const p = req.body;
    console.log('WhatsApp click received:', JSON.stringify(p));

    // ── BUILD ITEM NAME ───────────────────────────────────────
    const pagePath = p.page_path || p.last_page || 'Unknown page';
    const itemName = `WhatsApp Click — ${pagePath}`;

    // ── DETERMINE LEAD SOURCE ─────────────────────────────────
    // PPC if gclid present, otherwise Unknown
    const leadSource = p.gclid ? 'PPC' : 'Unknown';

    // ── BUILD MONDAY COLUMN VALUES ────────────────────────────
    const columnValues = {
      // Lead source (color/status column) — PPC or Unknown
      'color_mkxk8y67': { label: leadSource },

      // Channel — WhatsApp
      'dropdown_mkxkfbff': { labels: ['WhatsApp'] },

      // Second dropdown — WhatsApp
      'dropdown_mm1v31yb': { labels: ['WhatsApp'] },

      // GCLID
      ...(p.gclid && { 'text4__1': p.gclid }),

      // UTM fields
      ...(p.utm_campaign  && { 'text_mm1c3b5w': p.utm_campaign }),
      ...(p.utm_term      && { 'text3__1':      p.utm_term }),
      ...(p.utm_matchtype && { 'text_mm1d87rp': p.utm_matchtype }),

      // Pages
      ...(p.landing_page  && { 'text_mm1jhhe7': p.landing_page }),
      ...(p.last_page     && { 'text_mm2jw90v': p.last_page }),
    };

    // ── CREATE MONDAY ITEM ────────────────────────────────────
    const mutation = `
      mutation {
        create_item(
          board_id: ${LEADS_BOARD},
          item_name: ${JSON.stringify(itemName)},
          column_values: ${JSON.stringify(JSON.stringify(columnValues))}
        ) {
          id
        }
      }
    `;

    const mondayRes = await fetch(MONDAY_API, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': process.env.MONDAY_API_KEY
      },
      body: JSON.stringify({ query: mutation })
    });

    const mondayData = await mondayRes.json();

    if (mondayData.errors) {
      throw new Error('Monday API error: ' + JSON.stringify(mondayData.errors));
    }

    const pulseId = mondayData?.data?.create_item?.id;
    console.log('Monday WhatsApp lead created — pulse ID:', pulseId);

    return res.status(200).json({ success: true, pulseId });

  } catch (err) {
    console.error('submit-whatsapp error:', err.message);
    return res.status(200).json({ error: err.message });
  }
};
