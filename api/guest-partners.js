// ============================================================
//  Guest Services portal, partner perks.
//  GET /api/guest-partners     (Authorization: Bearer <token>)
//    200 { partners, categories, cities, cached }
//    401 no / expired session
//
//  Source of truth is a Monday board, so marketing adds a partner
//  by adding a row. Columns are matched by TITLE, not id, so the
//  board can be built in the UI without anyone reading column ids
//  out of the API. Rename a column and only that field goes blank.
//
//  BOARD SPEC (create once, set PARTNERS_BOARD_ID)
//    Item name   partner name              "Third Space, Soho"
//    Category    status or text            "Fitness"
//    City        status or text            "London" / "All cities"
//    Perk        text, short badge         "20% off membership"
//    Code        text                      "LUXE-TS20"
//    Description long text, one or two lines
//    Terms       long text, the small print
//    Link        link or text, partner url
//    Image URL   text, Squarespace CDN url (no ?format needed)
//    Status      status, "Active" publishes the row
//    Order       numbers, optional sort within a category
//
//  ENV
//    PARTNERS_BOARD_ID       required
//    PARTNERS_CACHE_SECONDS  default 300
//    CRON_SECRET             ?refresh=<secret> busts the cache
// ============================================================

const {
  applyCors, requireGuest, monday, gqlString, normalise
} = require('./_guest-auth.js');
const { logError } = require('./_errlog.js');

const CACHE_KEY = 'guest:partners:v1';
const CACHE_TTL = Number(process.env.PARTNERS_CACHE_SECONDS || 300);

// Board column title -> field, with the spellings people actually use.
const TITLE_MAP = {
  category: 'category', categories: 'category', type: 'category',
  city: 'city', location: 'city',
  perk: 'perk', offer: 'perk', discount: 'perk',
  code: 'code', promocode: 'code', discountcode: 'code',
  description: 'blurb', blurb: 'blurb', summary: 'blurb',
  terms: 'terms', conditions: 'terms', smallprint: 'terms',
  link: 'url', url: 'url', website: 'url', partnerlink: 'url',
  imageurl: 'image', image: 'image', photo: 'image',
  status: 'status', published: 'status',
  order: 'order', sort: 'order', sortorder: 'order'
};

// Link columns answer on `url`; status on `label`; mirror and lookup on
// `display_value`; everything else on `text`. Reading `text` alone gives a
// Link column's display label, not the address behind it.
function valueOf (col) {
  return col.url || col.label || col.display_value || col.text || '';
}

// Squarespace CDN images take ?format=; anything else is left alone.
function withFormat (url, size) {
  const u = String(url).trim();
  if (!u) return '';
  if (u.indexOf('format=') !== -1) return u;
  if (u.indexOf('squarespace-cdn.com') === -1 && u.indexOf('squarespace.com') === -1) return u;
  return u + (u.indexOf('?') === -1 ? '?' : '&') + 'format=' + size;
}

async function fetchPartners () {
  const boardId = (process.env.PARTNERS_BOARD_ID || '').trim();
  if (!boardId) throw new Error('PARTNERS_BOARD_ID is not set');

  const data = await monday(`
    query {
      boards(ids: [${gqlString(boardId)}]) {
        columns { id title type }
        items_page(limit: 200) {
          items {
            id
            name
            column_values {
              id text
              ... on StatusValue { label }
              ... on MirrorValue { display_value }
              ... on BoardRelationValue { display_value }
              ... on LinkValue { url }
            }
          }
        }
      }
    }
  `);

  const board = (data.boards || [])[0];
  if (!board) throw new Error('Partners board not found');

  // column id -> our field name
  const fieldById = {};
  (board.columns || []).forEach(c => {
    const field = TITLE_MAP[normalise(c.title)];
    if (field) fieldById[c.id] = field;
  });

  // Rename the Status column in Monday and every draft row would otherwise
  // publish, because a row with no status field is treated as publishable.
  // Fall back to the board's first status-type column so the gate survives
  // a rename, and only genuinely status-free boards publish everything.
  const hasStatusField = Object.keys(fieldById).some(id => fieldById[id] === 'status');
  if (!hasStatusField) {
    const statusCol = (board.columns || []).filter(c => c.type === 'status')[0];
    if (statusCol) fieldById[statusCol.id] = 'status';
  }

  const items = (board.items_page && board.items_page.items) || [];

  const partners = items.map(item => {
    const row = { name: item.name || '', id: item.id };
    (item.column_values || []).forEach(c => {
      const field = fieldById[c.id];
      if (field) row[field] = valueOf(c);
    });
    return row;
  }).filter(row => {
    // Only published rows leave the building. A board with no Status
    // column publishes everything, which is the sane default for a
    // board someone has just created.
    if (row.status === undefined) return !!row.name;
    return !!row.name && normalise(row.status) === 'active';
  }).map(row => ({
    name:     row.name,
    category: row.category || 'Other',
    city:     row.city || 'All cities',
    perk:     row.perk || '',
    code:     row.code || '',
    blurb:    row.blurb || '',
    terms:    row.terms || '',
    url:      row.url || '',
    // Right-size once, here, so the block never asks for a full-res tile.
    img:      row.image ? withFormat(row.image, '750w') : '',
    order:    Number(row.order || 0)
  }));

  partners.sort((a, b) => (a.order || 0) - (b.order || 0));

  const categories = [];
  const cities = [];
  partners.forEach(p => {
    if (categories.indexOf(p.category) === -1) categories.push(p.category);
    if (cities.indexOf(p.city) === -1) cities.push(p.city);
  });

  return { partners, categories, cities };
}

let _kv = null;
async function kv () {
  if (_kv) return _kv;
  const { Redis } = await import('@upstash/redis');
  _kv = Redis.fromEnv();
  return _kv;
}

module.exports = async function handler (req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // The operator cache-bust is checked first so it works with the secret
  // alone: it is an admin call from a terminal, which has no guest token.
  const bust = !!(req.query && req.query.refresh &&
                  process.env.CRON_SECRET &&
                  req.query.refresh === process.env.CRON_SECRET);

  try {
    if (!bust && !requireGuest(req, res)) return;

    if (!bust) {
      try {
        const k = await kv();
        const cached = await k.get(CACHE_KEY);
        if (cached) {
          const payload = typeof cached === 'string' ? JSON.parse(cached) : cached;
          return res.status(200).json(Object.assign({ cached: true }, payload));
        }
      } catch (err) { /* cache miss or Redis down, fall through to Monday */ }
    }

    const payload = await fetchPartners();

    try {
      const k = await kv();
      await k.set(CACHE_KEY, JSON.stringify(payload), { ex: CACHE_TTL });
    } catch (err) { /* caching is optional */ }

    return res.status(200).json(Object.assign({ cached: false }, payload));

  } catch (err) {
    logError('guest-partners', err);
    return res.status(500).json({ error: 'Could not load partners. Try again shortly.' });
  }
};
