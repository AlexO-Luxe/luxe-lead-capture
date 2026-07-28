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
const FRAG = `id name url
  column_values(ids: ${JSON.stringify(BOOKING_COLS)}) {
    id text
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
    if (data.errors) throw new Error('Monday API: ' + JSON.stringify(data.errors).slice(0, 240));
    return data;
  }
}

// Preferred path: ask Monday for bookings whose link_to_leads26 points at this
// lead. Board-relation rules are supported but fussy, so the caller falls back
// to a recent-items scan if this throws or finds nothing.
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

// Fallback: the booking we want was created or edited minutes ago, so it is at
// the top of a last-updated ordering. One page is enough and keeps this cheap.
async function findByRecentScan (leadId) {
  const data = await mondayQuery(`query {
    boards(ids: ${BOOKINGS_BOARD}) {
      items_page(limit: 100, query_params: { order_by: [{ column_id: "__last_updated__", direction: desc }] }) {
        items { ${FRAG} }
      }
    }
  }`);
  const items = data?.data?.boards?.[0]?.items_page?.items || [];
  return items.filter(it => linkedLeadIds(it).includes(String(leadId)));
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

  // More than one booking on the same lead (extension, rebooking): the most
  // recently touched row is the one the salesperson just filled in.
  const item = items[items.length - 1];
  return mapBooking(item);
}

function mapBooking (item) {
  const cv = {};
  (item.column_values || []).forEach(c => { cv[c.id] = c; });

  // date6 is the check-in the sales team fills in on the booking flow. date69
  // is the one the commission formula reads. They are normally the same date;
  // prefer date6 and fall back so an empty column never blanks the row.
  const checkIn   = txt(cv.date6) || txt(cv.date69);
  const checkOut  = txt(cv.date_1);
  const nights    = daysBetween(checkIn, checkOut);
  const rate      = txt(cv.numbers80) ? numOf(txt(cv.numbers80)) : null;
  const apartment = disp(cv.connect_boards25) || txt(cv.connect_boards25);

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

module.exports = { BOOKINGS_BOARD, BOOKING_COLS, fetchBookingForLead, mapBooking, resolveCommission };
