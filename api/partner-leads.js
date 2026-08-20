// ============================================================
//  GET /api/partner-leads     (Authorization: Bearer <token>)
//    200 { partner, groups, statuses, total, cached }
//    401 no / expired session
//
//  Read-only view of one institution's leads, straight off the
//  Monday Leads board. Deliberately NOT returned: email, phone,
//  message, IP, campaign, gclid. The school sees who enquired and
//  how far along it is, we keep the personal data.
//
//  MEMBERSHIP (either rule wins)
//    Source (WHERE) = "Partnerships" and Source (HOW) names them
//    University column names them
//  The second rule is what pulls in the years of leads captured
//  before the co-branded portal existed.
//
//  Groups mirror the board's own Top Level Status column, labels
//  and colours included, so renaming a status in Monday renames it
//  here. Anything outside GROUP_ORDER lands in "Other".
// ============================================================

const { requirePartner, applyCors, monday, kvGet, kvSet } = require('./_partner-auth.js');
const { logError } = require('./_errlog.js');

const LEADS_BOARD = '2171015719';
const CACHE_TTL   = Number(process.env.PARTNER_CACHE_SECONDS || 120);

// The stages the schools care about, in pipeline order. Anything else on the
// board (Spam, Postponed, Duplicated) is kept but parked in Other, so a lead
// can never silently vanish from their view.
const GROUP_ORDER = ['New Lead', 'Approached Lead', 'Lead In Progress', 'Qualified Lead', 'Unqualified Lead'];

const COLS = [
  'status',              // Top Level Status, drives the groups
  'people_1',            // Assigned, our advisor
  'color_mkxk8y67',      // Source (WHERE)
  'dropdown_mkxkfbff',   // Source (HOW)
  'text_mknfnmsb',       // University
  'apt_type_mkmn4bgg',   // Apartment type
  'dropdown6',           // Building / apartment ref
  'dropdown19',          // Areas
  'date47',              // Check in
  'date_1',              // Check out
  'budget_per_week',     // Guide price
  'text8',               // City
  'dropdown_mm1v31yb',   // Source form
  // Operator partners only. A referral is useless without a way to reach
  // the student, so these are returned for kind === 'operator' and never
  // for a school.
  'email',
  'phone_1',
  'dropdown40',          // Prefer to be contacted
  'long_text7',          // Message from the guest
  'color_mm6d7xqf',      // Operator Status: Enquiry / Booking, written by them
];

function val (item, id) {
  const c = item.column_values.find(c => c.id === id);
  if (!c) return '';
  return (c.label || c.display_value || c.text || '').trim();
}

// Monday holds status colours in settings_str, so the portal inherits them
// rather than keeping its own palette in sync by hand.
async function statusPalette () {
  const data = await monday(`{ boards(ids: ${LEADS_BOARD}) { columns(ids: ["status"]) { settings_str } } }`);
  const raw = data?.boards?.[0]?.columns?.[0]?.settings_str;
  const out = {};
  try {
    const s = JSON.parse(raw || '{}');
    Object.entries(s.labels || {}).forEach(([idx, label]) => {
      if (label) out[label] = (s.labels_colors && s.labels_colors[idx] && s.labels_colors[idx].color) || '#c4c4c4';
    });
  } catch (err) { /* palette is cosmetic, a parse failure must not break the board */ }
  return out;
}

async function fetchByRule (rule) {
  const items = [];
  let cursor = null;
  // Cap the walk: a partner with more than 1000 leads is a good problem, and
  // an unbounded loop against a paging API is not.
  for (let page = 0; page < 10; page++) {
    const params = cursor
      ? `cursor: ${JSON.stringify(cursor)}`
      : `query_params: { rules: [${rule}], operator: and }`;
    const q = `{ boards(ids: ${LEADS_BOARD}) { items_page(limit: 100, ${params}) {
      cursor
      items { id name created_at updated_at column_values(ids: ${JSON.stringify(COLS)}) {
        id text
        ... on StatusValue { label }
        ... on MirrorValue { display_value }
        ... on BoardRelationValue { display_value }
      } }
    } } }`;
    const data = await monday(q);
    const pageData = data?.boards?.[0]?.items_page;
    if (!pageData) break;
    items.push(...(pageData.items || []));
    cursor = pageData.cursor;
    if (!cursor) break;
  }
  return items;
}

// PBSA referrals: every Standard student living enquiry, split by the
// Building column. A lead with no building named is nobody's yet, so it
// stays out of both operator views until someone picks a building.
async function fetchOperatorLeads (partner) {
  const items = await fetchByRule('{ column_id: "apt_type_mkmn4bgg", compare_value: ["Standard student living"], operator: contains_text }');
  return items.filter(item => partner.buildings.test(val(item, 'dropdown6')));
}

async function fetchLeads (partner) {
  if (partner.kind === 'operator') return fetchOperatorLeads(partner);
  const [bySource, byUniversity] = await Promise.all([
    fetchByRule(`{ column_id: "color_mkxk8y67", compare_value: ["${partner.source}"], operator: any_of }`),
    fetchByRule(`{ column_id: "text_mknfnmsb", compare_value: ["${partner.short}"], operator: contains_text }`),
  ]);

  const byId = new Map();
  [...bySource, ...byUniversity].forEach(i => byId.set(i.id, i));

  return [...byId.values()].filter(item => {
    const university = val(item, 'text_mknfnmsb');
    const source     = val(item, 'color_mkxk8y67');
    const channel    = val(item, 'dropdown_mkxkfbff');
    if (partner.match.test(university)) return true;
    return source === partner.source && partner.match.test(channel);
  });
}

function shape (item, partner) {
  const status = val(item, 'status') || 'No status';
  const contact = partner.kind === 'operator' ? {
    email:   val(item, 'email'),
    phone:   val(item, 'phone_1'),
    prefers: val(item, 'dropdown40'),
    message: val(item, 'long_text7'),
  } : {};
  return {
    ...contact,
    id:        item.id,
    name:      item.name,
    status,
    owner:     val(item, 'people_1'),
    type:      val(item, 'apt_type_mkmn4bgg'),
    building:  val(item, 'dropdown6').replace(/^standard student living\s*[-\u2013]\s*/i, ''),
    university: val(item, 'text_mknfnmsb'),
    // Blank means nobody has touched it yet, which reads as an enquiry.
    operatorStatus: val(item, 'color_mm6d7xqf') || 'Enquiry',
    areas:     val(item, 'dropdown19'),
    city:      val(item, 'text8'),
    budget:    val(item, 'budget_per_week'),
    checkIn:   val(item, 'date47'),
    checkOut:  val(item, 'date_1'),
    form:      val(item, 'dropdown_mm1v31yb'),
    created:   item.created_at,
    updated:   item.updated_at,
  };
}

// Whole nights between the two dates, or null when either is missing. Shown
// as weeks in the UI, which is how student lets are actually discussed.
function nightsBetween (a, b) {
  if (!a || !b) return null;
  const n = Math.round((new Date(b) - new Date(a)) / 86400000);
  return n > 0 ? n : null;
}

module.exports = async function handler (req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const partner = requirePartner(req, res);
  if (!partner) return;

  const cacheKey = 'partner:leads:' + partner.key;
  try {
    if (!req.query.refresh) {
      const hit = await kvGet(cacheKey);
      if (hit) return res.status(200).json({ ...hit, cached: true });
    }

    const [items, palette] = await Promise.all([fetchLeads(partner), statusPalette()]);
    const leads = items.map(i => shape(i, partner)).map(l => ({ ...l, nights: nightsBetween(l.checkIn, l.checkOut) }));

    // Newest first inside every group: a school opening this wants today's
    // enquiries, not the 2025 archive.
    leads.sort((a, b) => new Date(b.created) - new Date(a.created));

    // An operator does not care about our sales pipeline. They get two
    // groups they own: everything they are still working, and the ones that
    // turned into a booking. A school keeps the Monday status grouping.
    const groups = partner.kind === 'operator'
      ? [
          { title: 'Enquiries', colour: '#fdab3d', leads: leads.filter(l => l.operatorStatus !== 'Booking') },
          { title: 'Bookings',  colour: '#00c875', leads: leads.filter(l => l.operatorStatus === 'Booking') },
        ]
      : [...GROUP_ORDER, 'Other'].map(title => ({
          title,
          colour: palette[title] || '#c4c4c4',
          leads:  leads.filter(l => (GROUP_ORDER.includes(l.status) ? l.status : 'Other') === title),
        })).filter(g => g.leads.length > 0 || GROUP_ORDER.includes(g.title));

    const payload = {
      partner:  { key: partner.key, name: partner.name, logo: partner.logo, kind: partner.kind || 'school' },
      groups,
      statuses: palette,
      total:    leads.length,
      synced:   new Date().toISOString(),
    };

    await kvSet(cacheKey, payload, CACHE_TTL);
    return res.status(200).json({ ...payload, cached: false });
  } catch (err) {
    await logError('partner-leads', err, { partner: partner.key });
    return res.status(500).json({ error: 'Could not load leads right now.' });
  }
};
