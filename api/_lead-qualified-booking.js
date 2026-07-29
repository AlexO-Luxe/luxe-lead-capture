// _lead-qualified-booking.js
//
// Pulls the Booking Flow board row that belongs to a qualified lead, so the
// Lead Qualified email can show what the salesperson actually agreed:
// apartment, check-in, nights, nightly rate, total Luxe commission.
//
// This is the reason the email is delayed. The booking row is created and
// filled in the minutes AFTER the lead is flipped to Qualified, so we read it
// at send time, not at webhook time.
//
// Board: 2171015589 (Bookings, called "Booking Flow" in the UI).
// The relation lives on the Bookings side (link_to_leads26 -> Leads), so the
// lookup is a reverse one: find the booking whose linked lead is this item.
//
// Columns (given by Alex, 2026-07):
//   connect_boards25  Apartment Agreed        (board relation -> Apartments)
//   date6             Check in Date           (falls back to date69, the
//                                              check-in the commission
//                                              formula itself uses)
//   date_1            Check Out               (nights are derived, there is no
//                                              nights column on the board)
//   numbers80         Agreed Nightly Rate
//   formula2          Total Luxe Commission excl VAT
//
// formula2 is a Monday formula over cross-board mirrors, so the API returns
// null for it. Resolution order for the commission: the formula's own value if
// Monday ever starts returning one, then numeric_mm1ge9h4 ("Rev to Google",
// hand-entered or filled by the sync cron), then a recompute from the base
// columns via _booking-value.js, flagged as an estimate.

const MONDAY_API     = 'https://api.monday.com/v2';
const BOOKINGS_BOARD = 2171015589;
const MONDAY_SLUG    = process.env.MONDAY_ACCOUNT_SLUG || 'student-luxe';

const { FORMULA2_COLS, computeFormula2, txt, disp, numOf, daysBetween } = require('./_booking-value.js');

const BOOKING_COLS = [
  ...new Set([
    ...FORMULA2_COLS,   // includes date69, date_1, numbers80 and the mirrors
    'connect_boards25', // Apartment Agreed
    'date6',            // Check in Date
    'formula2',         // Total Luxe Commission excl VAT
    'numeric_mm1ge9h4', // Rev to Google (the readable copy of formula2)
    'date9',            // Close date, set when the booking is confirmed
    'status',
    'link_to_leads26'   // relation back to the Leads board
  ])
];

// Formula and board-relation columns only expose their value through the typed
// fragments, never through `text`. Mirror columns likewise (see CLAUDE.md).
//
// Every column is fetched, not just BOOKING_COLS: Monday silently returns
// nothing for an id that does not exist on the board, so a single wrong or
// renamed id would show as a permanently blank field with no error. Reading
// the lot lets the apartment be resolved by column title as well as by id.
const FRAG = `id name url
  column_values {
    id text type
    ... on MirrorValue        { display_value }
    ... on BoardRelationValue { display_value linked_item_ids }
    ... on FormulaValue       { display_value }
    ... on StatusValue        { label }
  }`;

async function mondayQuery (query, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(MONDAY_API, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
      body:    JSON.stringify({ query })
    });
    const text = await r.text();
    if (!text.trim().startsWith('{')) {
      if (attempt < retries) { await new Promise(s => setTimeout(s, 1000)); continue; }
      throw new Error('Monday API returned non-JSON: ' + text.substring(0, 80));
    }
    const data = JSON.parse(text);
    if (data.errors) {
      const msg = JSON.stringify(data.errors).slice(0, 240);
      // Monday times out heavy or unlucky queries as a normal errors payload.
      // Transient: retry like a network blip instead of giving up.
      if (/REQUEST_TIMEOUT|timed out|ComplexityException|budget exhausted/i.test(msg) && attempt < retries) {
        await new Promise(s => setTimeout(s, 1500 * (attempt + 1)));
        continue;
      }
      throw new Error('Monday API: ' + msg);
    }
    return data;
  }
}

// Preferred path: ask Monday for bookings whose link_to_leads26 points at this
// lead. Monday does not really filter on board-relation columns: sometimes it
// errors, sometimes it just returns 0 rows (observed in production), so a
// clean empty answer here proves nothing and the caller always falls back to
// the recent scan.
async function findByRelationRule (leadId) {
  const data = await mondayQuery(`query {
    boards(ids: ${BOOKINGS_BOARD}) {
      items_page(limit: 10, query_params: {
        rules: [{ column_id: "link_to_leads26", compare_value: ["${Number(leadId)}"], operator: any_of }]
      }) { items { ${FRAG} } }
    }
  }`);
  return data?.data?.boards?.[0]?.items_page?.items || [];
}

// Fallback: the booking we want was created or edited minutes ago, so it is
// near the top of a last-updated ordering.
//
// Two phases, because one is what timed out in production: 200 items times
// every mirror/formula column is exactly the query shape sync-booking-values
// warns is far too slow. Phase 1 reads ONLY the relation column for the
// recent items (cheap), phase 2 fetches the single matching row in full.
const LIGHT_FRAG = `id
  column_values(ids: ["link_to_leads26"]) {
    id
    ... on BoardRelationValue { linked_item_ids }
  }`;

const SCAN_PAGES = 2;   // x100 items; the booking was touched minutes ago

async function findByRecentScan (leadId) {
  const matchIds = [];
  let cursor = null;
  for (let page = 0; page < SCAN_PAGES; page++) {
    const query = cursor
      ? `query { next_items_page(limit: 100, cursor: ${JSON.stringify(cursor)}) { cursor items { ${LIGHT_FRAG} } } }`
      : `query { boards(ids: ${BOOKINGS_BOARD}) {
           items_page(limit: 100, query_params: { order_by: [{ column_id: "__last_updated__", direction: desc }] }) {
             cursor items { ${LIGHT_FRAG} }
           } } }`;
    const d = await mondayQuery(query);
    const pageData = cursor ? d?.data?.next_items_page : d?.data?.boards?.[0]?.items_page;
    if (!pageData) break;
    for (const it of pageData.items || []) {
      if (linkedLeadIds(it).includes(String(leadId))) matchIds.push(String(it.id));
    }
    if (matchIds.length) break;   // the freshest match wins, no need to page on
    cursor = pageData.cursor;
    if (!cursor) break;
  }
  if (!matchIds.length) return [];

  const data = await mondayQuery(`query {
    items(ids: [${matchIds.map(Number).join(', ')}]) { ${FRAG} }
  }`);
  return data?.data?.items || [];
}

// Column titles for the board, so a field can be found by what it is called
// when its id does not match. Cached for the life of the function instance.
let _titles = null;
async function columnTitles () {
  if (_titles) return _titles;
  try {
    const data = await mondayQuery(`query {
      boards(ids: ${BOOKINGS_BOARD}) { columns { id title type } }
    }`);
    const cols = data?.data?.boards?.[0]?.columns || [];
    _titles = Object.fromEntries(cols.map(c => [c.id, { title: c.title || '', type: c.type || '' }]));
  } catch (err) {
    console.warn('columnTitles failed:', err.message);
    _titles = {};
  }
  return _titles;
}

// Value of a column whatever its type: relation and formula and mirror columns
// answer on display_value, status on label, the rest on text.
function valueOf (c) {
  if (!c) return '';
  return String(c.display_value || c.label || c.text || '').trim();
}

// Apartment Agreed, by id first and by column title second. connect_boards25
// is what Alex gave us, but a wrong or renamed id would otherwise render as a
// permanently empty field, so fall back to the column actually called
// "Apartment Agreed", then to any apartment column carrying a value.
function resolveApartment (cv, titles) {
  const byId = valueOf(cv.connect_boards25);
  if (byId) return byId;

  const named = Object.keys(cv).filter(id => {
    const t = (titles[id]?.title || '').toLowerCase();
    return t === 'apartment agreed' || t === 'apartment';
  });
  for (const id of named) {
    const v = valueOf(cv[id]);
    if (v) return v;
  }

  // Last resort: any column whose title mentions an apartment and holds a
  // value. Ordered so a board relation (the apartment itself) beats a plain
  // text or dropdown field like "Apartment Type".
  const loose = Object.keys(cv)
    .filter(id => /apartment|apt/i.test(titles[id]?.title || ''))
    .sort((a, b) => (titles[b]?.type === 'board_relation' ? 1 : 0) - (titles[a]?.type === 'board_relation' ? 1 : 0));
  for (const id of loose) {
    const v = valueOf(cv[id]);
    if (v) return v;
  }
  return '';
}

function linkedLeadIds (item) {
  const c = (item.column_values || []).find(cv => cv.id === 'link_to_leads26');
  return ((c && c.linked_item_ids) || []).map(String);
}

// Returns the booking-flow detail for a lead, or null when there is no linked
// booking yet (the normal case for a lead that was qualified but not yet
// progressed). Never throws: a Monday hiccup must not stop the email.
async function fetchBookingForLead (leadId) {
  let items = [];
  try {
    items = await findByRelationRule(leadId);
  } catch (err) {
    console.warn('booking relation-rule lookup failed, scanning recent items:', err.message);
  }
  if (!items.length) {
    try {
      items = await findByRecentScan(leadId);
    } catch (err) {
      console.warn('booking recent scan failed:', err.message);
      return null;
    }
  }
  if (!items.length) return null;

  // More than one booking on the same lead (extension, rebooking): the scan
  // returns most-recently-updated first, and that is the row the salesperson
  // just filled in.
  const item = items[0];
  return mapBooking(item, await columnTitles());
}

function mapBooking (item, titles = {}) {
  const cv = {};
  (item.column_values || []).forEach(c => { cv[c.id] = c; });

  // date6 is the check-in the sales team fills in on the booking flow. date69
  // is the one the commission formula reads. They are normally the same date;
  // prefer date6 and fall back so an empty column never blanks the row.
  const checkIn   = txt(cv.date6) || txt(cv.date69);
  const checkOut  = txt(cv.date_1);
  const nights    = daysBetween(checkIn, checkOut);
  const rate      = txt(cv.numbers80) ? numOf(txt(cv.numbers80)) : null;
  const apartment = resolveApartment(cv, titles);

  const commission = resolveCommission(cv);

  const filled = [apartment, checkIn, nights, rate, commission.value].some(v => v !== null && v !== undefined && v !== '');
  if (!filled) return null;

  return {
    itemId:     String(item.id),
    name:       item.name || '',
    apartment:  apartment || '',
    checkIn,
    checkOut,
    nights:     nights == null ? '' : nights,
    nightlyRate: rate,
    commission: commission.value,
    commissionEstimated: commission.estimated,
    status:     cv.status?.label || txt(cv.status) || '',
    confirmed:  !!txt(cv.date9),
    url:        item.url || `https://${MONDAY_SLUG}.monday.com/boards/${BOOKINGS_BOARD}/pulses/${item.id}`
  };
}

// { value: number|null, estimated: boolean }
function resolveCommission (cv) {
  const formula = disp(cv.formula2);
  if (formula) return { value: numOf(formula), estimated: false };

  const stored = txt(cv.numeric_mm1ge9h4);
  if (stored) return { value: numOf(stored), estimated: false };

  const calc = computeFormula2(cv);
  if (calc != null) return { value: calc, estimated: true };

  return { value: null, estimated: false };
}

// Diagnostic for /api/test-lead-qualified?debug=booking&itemId=<leadId>.
// Dumps how the booking row was found, every column on it that holds a value
// (id, title, type, value), and what the email would render. Use it to confirm
// a column id rather than guessing at one.
async function debugBookingForLead (leadId) {
  const out = { leadId: String(leadId), foundVia: null, rule: null, scan: null };

  let items = [];
  try {
    items = await findByRelationRule(leadId);
    out.rule = { ok: true, matches: items.length };
    if (items.length) out.foundVia = 'relation-rule';
  } catch (err) {
    out.rule = { ok: false, error: err.message };
  }

  if (!items.length) {
    try {
      items = await findByRecentScan(leadId);
      out.scan = { ok: true, matches: items.length };
      if (items.length) out.foundVia = 'recent-scan';
    } catch (err) {
      out.scan = { ok: false, error: err.message };
    }
  }

  if (!items.length) {
    out.booking = null;
    out.note = 'No booking row on board ' + BOOKINGS_BOARD + ' links to this lead via link_to_leads26 ' +
               '(checked the ' + SCAN_PAGES * 100 + ' most recently updated bookings).';
    return out;
  }

  const item   = items[0];
  const titles = await columnTitles();
  out.item = { id: String(item.id), name: item.name };
  out.columnsWithValues = (item.column_values || [])
    .map(c => ({ id: c.id, title: titles[c.id]?.title || '', type: c.type || titles[c.id]?.type || '', value: valueOf(c) }))
    .filter(c => c.value !== '');
  out.rendered = mapBooking(item, titles);
  return out;
}

module.exports = {
  BOOKINGS_BOARD,
  BOOKING_COLS,
  fetchBookingForLead,
  debugBookingForLead,
  mapBooking,
  resolveApartment,
  resolveCommission,
  columnTitles
};
