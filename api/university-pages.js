// ============================================================
//  Student Luxe — University Pages API
//  Deploy to: /api/university-pages.js in your Vercel project
//
//  Fetches university items from Monday board 18392931240 where:
//    color_mkyw8gdm  = 'Uni Page'
//    dropdown_mkzkn4y9 = city (passed as ?city=london)
//
//  Returns: name, url, areas, photo1, photo2, featured
//
//  Cache: 1 hour in-memory, bust with ?bust=1
// ============================================================

const MONDAY_API   = 'https://api.monday.com/v2';
const BOARD_ID     = 18392931240;
const STATUS_COL   = 'color_mkyw8gdm';
const STATUS_VAL   = 'Uni Page';
const CITY_COL     = 'dropdown_mkzkn4y9';
const URL_COL      = 'link_mkyw9d7e';
const AREAS_COL    = 'dropdown_mm29fvbk';
const PHOTO1_COL   = 'link_mm29enn7';
const PHOTO2_COL   = 'link_mm29g8jk';
const FEATURED_COL = 'boolean_mm2941q3';

const CACHE_TTL_MS = 60 * 60 * 1000;

let cache = {};
let cacheTime = {};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const city = (req.query && req.query.city || 'london').toLowerCase().trim();
  const bust  = req.query && req.query.bust;

  // Return cached result if fresh
  if (!bust && cache[city] && Date.now() - (cacheTime[city] || 0) < CACHE_TTL_MS) {
    return res.status(200).json({ universities: cache[city], cached: true });
  }

  try {
    const universities = [];
    let cursor = null;
    let page = 0;

    do {
      page++;
      const query = `
        {
          boards(ids: [${BOARD_ID}]) {
            items_page(limit: 500${cursor ? `, cursor: "${cursor}"` : ''}) {
              cursor
              items {
                name
                column_values(ids: [
                  "${STATUS_COL}",
                  "${CITY_COL}",
                  "${URL_COL}",
                  "${AREAS_COL}",
                  "${PHOTO1_COL}",
                  "${PHOTO2_COL}",
                  "${FEATURED_COL}"
                ]) {
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
        console.error('Monday API errors:', JSON.stringify(data.errors));
        return res.status(500).json({ error: 'Monday API error', details: data.errors });
      }

      const page_data = data?.data?.boards?.[0]?.items_page;
      const items     = page_data?.items || [];
      cursor          = page_data?.cursor || null;

      console.log(`Page ${page}: ${items.length} items, cursor: ${cursor ? 'yes' : 'end'}`);

      for (const item of items) {
        const col = id => item.column_values.find(c => c.id === id);

        // Filter: must be 'Uni Page'
        const statusCol = col(STATUS_COL);
        if (!statusCol || statusCol.text !== STATUS_VAL) continue;

        // Filter: must match requested city
        const cityCol = col(CITY_COL);
        const itemCity = (cityCol && cityCol.text || '').toLowerCase().trim();
        if (itemCity !== city) continue;

        // URL
        const urlCol = col(URL_COL);
        let url = '';
        if (urlCol) {
          if (urlCol.value) {
            try { url = JSON.parse(urlCol.value).url || ''; } catch {}
          }
          if (!url) url = urlCol.text || '';
        }
        if (!url) { console.log(`Skipping "${item.name}" — no URL`); continue; }

        // Extract slug from full URL
        const slug = url
          .replace(/^https?:\/\/(www\.)?studentluxe\.co\.uk/, '')
          .replace(/\/$/, '')
          .toLowerCase()
          .trim() || url;

        // Areas — simple dropdown, text field contains comma-separated values
        const areasCol = col(AREAS_COL);
        const areas = areasCol && areasCol.text
          ? areasCol.text.split(',').map(a => a.trim()).filter(Boolean)
          : [];

        // Photos
        const extractLink = colId => {
          const c = col(colId);
          if (!c) return '';
          if (c.value) { try { return JSON.parse(c.value).url || ''; } catch {} }
          return c.text || '';
        };
        const photo1 = extractLink(PHOTO1_COL);
        const photo2 = extractLink(PHOTO2_COL);

        // Featured
        const featuredCol = col(FEATURED_COL);
        const featured = featuredCol && (featuredCol.value === 'true' || featuredCol.text === 'true' || featuredCol.value === '{"checked":"true"}');

        // Clean name — only strip URL if item name was accidentally saved as a URL
        let name = item.name.trim();
        if (name.startsWith('http')) {
          name = name
            .replace(/^https?:\/\/(www\.)?studentluxe\.co\.uk/, '')
            .replace(/\/$/, '')
            .split('/')
            .pop()
            .replace(/-accommodation$/, '')
            .replace(/-/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .trim();
        }

        universities.push({ name, slug, areas, photo1, photo2, featured });
      }

    } while (cursor);

    // Sort: featured first, then alphabetical
    universities.sort((a, b) => {
      if (a.featured && !b.featured) return -1;
      if (!a.featured && b.featured) return 1;
      return a.name.localeCompare(b.name);
    });

    cache[city]     = universities;
    cacheTime[city] = Date.now();

    console.log(`University pages loaded for ${city}: ${universities.length} items (${universities.filter(u => u.featured).length} featured)`);
    return res.status(200).json({ universities });

  } catch (err) {
    console.error('university-pages error:', err);
    return res.status(500).json({ error: err.message });
  }
};
