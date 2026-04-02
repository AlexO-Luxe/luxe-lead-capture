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
    // Allow cache bypass with ?bust=1
    const bust = req.query && req.query.bust;

    // Return cached result if still fresh
    if (!bust && cache && Date.now() - cacheTime < CACHE_TTL_MS) {
      return res.status(200).json({ apartments: cache, cached: true });
    }

    const apartments = [];
    let cursor = null;
    let page = 0;

    // Paginate through all items using cursor
    do {
      page++;
      const query = `
        {
          boards(ids: [${BOARD_ID}]) {
            items_page(limit: 500${cursor ? `, cursor: "${cursor}"` : ''}) {
              cursor
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

      const page_data = data?.data?.boards?.[0]?.items_page;
      const items     = page_data?.items || [];
      cursor          = page_data?.cursor || null;

      console.log(`Page ${page}: fetched ${items.length} items, cursor: ${cursor ? 'yes' : 'end'}`);

      for (const item of items) {
        const statusCol = item.column_values.find(c => c.id === STATUS_COL);
        const urlCol    = item.column_values.find(c => c.id === URL_COL);

        if (!statusCol || statusCol.text !== 'Apartment Page') continue;

        // Extract URL value
        let rawUrl = '';
        if (urlCol) {
          if (urlCol.value) {
            try {
              const parsed = JSON.parse(urlCol.value);
              rawUrl = parsed.url || parsed.text || '';
            } catch {
              rawUrl = urlCol.text || '';
            }
          }
          if (!rawUrl) rawUrl = urlCol.text || '';
        }

        if (!rawUrl) {
          console.log(`Skipping "${item.name}" — no URL found`);
          continue;
        }

        // Extract slug
        let slug = rawUrl
          .replace(/^https?:\/\/(www\.)?studentluxe\.co\.uk/, '')
          .replace(/\/$/, '')
          .toLowerCase()
          .trim();

        if (!slug) continue;

        console.log(`  → slug: ${slug}`);

        // Use item name as display name
        // If it looks like a URL, extract a clean name from the path
        let name = item.name.trim();
        if (name.startsWith('http')) {
          name = name
            .replace(/^https?:\/\/(www\.)?studentluxe\.co\.uk/, '')
            .replace(/\/$/, '')
            .split('/')
            .pop()
            .replace(/-/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());
        }

        const city = detectCity(slug);
        apartments.push({ slug, name, city });
      }

    } while (cursor); // keep fetching until no more pages

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
  // Sub-path cities (check these first — most specific)
  if (slug.includes('/barcelona'))    return 'barcelona';
  if (slug.includes('/paris'))        return 'paris';
  if (slug.includes('/madrid'))       return 'madrid';
  if (slug.includes('/new-york') || slug.includes('/newyork')) return 'new-york';
  if (slug.includes('/lisbon'))       return 'lisbon';
  if (slug.includes('/amsterdam'))    return 'amsterdam';
  if (slug.includes('/boston'))       return 'boston';
  if (slug.includes('/chicago'))      return 'chicago';
  if (slug.includes('/philadelphia')) return 'philadelphia';
  if (slug.includes('/washingtondc')) return 'washington';
  if (slug.includes('/virginia'))     return 'washington';
  if (slug.includes('/dublin'))       return 'dublin';
  if (slug.includes('/florence'))     return 'florence';
  if (slug.includes('/milan'))        return 'milan';
  if (slug.includes('/rome'))         return 'rome';
  if (slug.includes('/helsinki'))     return 'helsinki';
  if (slug.includes('/porto'))        return 'porto';
  if (slug.includes('/liverpool'))    return 'liverpool';
  if (slug.includes('/birmingham'))   return 'birmingham';
  if (slug.includes('/nottingham'))   return 'nottingham';
  if (slug.includes('/brighton'))     return 'brighton';
  if (slug.includes('/bristol'))      return 'bristol';
  if (slug.includes('/valencia'))     return 'valencia';

  // Slug-keyword cities (no subfolder)
  if (slug.includes('edinburgh'))  return 'edinburgh';
  if (slug.includes('manchester') || slug.includes('salford') || slug.includes('deansgate')) return 'manchester';
  if (slug.includes('cambridge'))  return 'cambridge';
  if (slug.includes('glasgow'))    return 'glasgow';
  if (slug.includes('durham'))     return 'durham';
  if (slug.includes('bristol'))    return 'bristol';
  if (slug.includes('brighton'))   return 'brighton';
  if (slug.includes('birmingham')) return 'birmingham';

  return 'london';
}
