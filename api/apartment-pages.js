// ============================================================
//  Student Luxe — Apartment Pages Map
//  Deploy to: /api/apartment-pages.js in your Vercel project
//
//  Fetches items from Monday board 18392931240 where
//  color_mkyw8gdm = 'Apartment Page', extracts slug + name,
//  and returns a clean map for the floating enquiry widget.
//
//  Simple in-memory cache: re-fetches at most once per hour.
// ============================================================

const MONDAY_API   = 'https://api.monday.com/v2';
const BOARD_ID     = 18392931240;
const STATUS_COL   = 'color_mkyw8gdm';
const URL_COL      = 'link_mkyw9d7e';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cache = null;
let cacheTime = 0;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Return cached result if still fresh
    if (cache && Date.now() - cacheTime < CACHE_TTL_MS) {
      return res.status(200).json({ apartments: cache });
    }

    const query = `
      {
        boards(ids: [${BOARD_ID}]) {
          items_page(limit: 500) {
            items {
              name
              column_values(ids: ["${STATUS_COL}", "${URL_COL}"]) {
                id
                text
                value
              }
            }
          }
        }
      }
    `;

    const response = await fetch(MONDAY_API, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': process.env.MONDAY_API_KEY
      },
      body: JSON.stringify({ query })
    });

    const data = await response.json();

    if (data.errors) {
      console.error('Monday API errors:', data.errors);
      return res.status(500).json({ error: 'Monday API error' });
    }

    const items = data?.data?.boards?.[0]?.items_page?.items || [];
    const apartments = [];

    for (const item of items) {
      const statusCol = item.column_values.find(c => c.id === STATUS_COL);
      const urlCol    = item.column_values.find(c => c.id === URL_COL);

      // Only include items marked as Apartment Page
      if (!statusCol || statusCol.text !== 'Apartment Page') continue;

      // Extract URL value
      let rawUrl = '';
      if (urlCol?.value) {
        try {
          const parsed = JSON.parse(urlCol.value);
          rawUrl = parsed.url || parsed.text || urlCol.text || '';
        } catch {
          rawUrl = urlCol.text || '';
        }
      }

      if (!rawUrl) continue;

      // Extract slug — strip domain, keep path
      let slug = rawUrl
        .replace(/^https?:\/\/(www\.)?studentluxe\.co\.uk/, '')
        .replace(/\/$/, '')
        .toLowerCase()
        .trim();

      if (!slug) continue;

      // Clean display name from item name
      // If item name looks like a URL, extract meaningful part
      let name = item.name.trim();
      if (name.startsWith('http')) {
        // e.g. https://www.studentluxe.co.uk/barcelona/fontana-suites → Fontana Suites
        name = name
          .replace(/^https?:\/\/(www\.)?studentluxe\.co\.uk/, '')
          .replace(/\/$/, '')
          .split('/')
          .pop()                          // take last path segment
          .replace(/-/g, ' ')             // hyphens to spaces
          .replace(/\b\w/g, c => c.toUpperCase()); // title case
      }

      // Detect city from slug
      const city = detectCity(slug);

      apartments.push({ slug, name, city });
    }

    cache     = apartments;
    cacheTime = Date.now();

    console.log(`Apartment pages loaded: ${apartments.length} items`);
    return res.status(200).json({ apartments });

  } catch (err) {
    console.error('apartment-pages error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ── Detect city from slug ────────────────────────────────────
function detectCity(slug) {
  if (slug.includes('barcelona'))  return 'barcelona';
  if (slug.includes('paris'))      return 'paris';
  if (slug.includes('madrid'))     return 'madrid';
  if (slug.includes('new-york') || slug.includes('newyork')) return 'new-york';
  if (slug.includes('edinburgh'))  return 'edinburgh';
  if (slug.includes('manchester')) return 'manchester';
  if (slug.includes('cambridge'))  return 'cambridge';
  if (slug.includes('bristol'))    return 'bristol';
  if (slug.includes('durham'))     return 'durham';
  if (slug.includes('glasgow'))    return 'glasgow';
  // Default to London
  return 'london';
}
