// _lead-qualified-booking.js
//
// Pulls the Booking Flow row that belongs to a qualified lead, so the Lead
// Qualified email can show what the salesperson actually agreed: apartment,
// check-in, nights, nightly rate, total Luxe commission.
//
// This is the reason the email is delayed: the booking row is created and
// filled in the minutes AFTER the lead is flipped to Qualified, so it is read
// at send time, not at webhook time.
//
// Finding the row is the hard part, learned the hard way in production:
//   - The Leads board's Booking Flow connection is connect_boards75. Which
//     board it points at is read from that column's OWN settings_str, not
//     assumed. (2171015589, the Bookings board, is only the fallback.)
//   - Monday's items_page rules do not really filter on board-relation
//     columns: they return 0 rows instead of erroring, proving nothing.
//   - The salesperson may link the booking to the lead, or to the guest's
//     Contact item, or forget to link it at all.
//
// So the lookup runs, in order, stopping at the first hit:
//   1. lead-relations : follow every board-relation column on the lead
//   2. contact-hop    : follow the relations of the items the lead links to
//                       (lead -> contact -> booking)
//   3. relation-rule  : legacy link_to_leads26 rule query (Bookings board only)
//   4. recent-scan    : cheap scan of the 200 most recently updated rows on
//                       the booking flow board, matching ANY relation column
//                       that links back to the lead
//   5. name-match     : same scan, matching the guest's name, for rows nobody
//                       linked
//
// Columns on the booking row (given by Alex, 2026-07):
//   connect_boards25  Apartment Agreed   (may also live on the LEAD as a
//                                         relation to an Apartments board)
//   date6             Check in Date      (falls back to date69)
//   date_1            Check Out          (nights are derived)
//   numbers80         Agreed Nightly Rate
//   formula2          Total Luxe Commission excl VAT
//
// formula2 is a formula over cross-board mirrors, so the API returns null for
// it. Commission resolves: formula2 if Monday ever returns it, then
// numeric_mm1ge9h4 (Rev to Google), then a recompute from the base columns
// via _booking-value.js, flagged as an estimate.

const MONDAY_API     = 'https://api.monday.com/v2';
const BOOKINGS_BOARD = 2171015589;   // legacy fallback if settings are unreadable
const LEADS_BOARD    = 2171015719;
const MONDAY_SLUG    = process.env.MONDAY_ACCOUNT_SLUG || 'student-luxe';

const { FORMULA2_COLS, computeFormula2, txt, disp, numOf, daysBetween } = require('./_booking-value.js');

const BOOKING_COLS = [
  ...new Set([
    ...FORMULA2_COLS,
    'connect_boards25',
    'date6',
    'formula2',
    'numeric_mm1ge9h4',
    'date9',
    'status',
    'link_to_leads26'
  ])
];

// Full row read: every column, because Monday silently returns nothing for an
// id that does not exist on a board, and the typed fragments are the only way
// formula / relation / mirror columns expose a value.
const FRAG = `id name url updated_at
  board { id }
  column_values {
    id text type
    ... on MirrorValue        { display_value }
    ... on BoardRelationValue { display_value linked_item_ids }
    ... on FormulaValue       { display_value }
    ... on StatusValue        { label }
  }`;

// Cheap scan read: id, name, and relation links only. 200 rows x mirrors and
// formulas is the query shape that timed out in production; this is not that.
const LIGHT_FRAG = `id name
  column_values {
    id type
    ... on BoardRelationValue { linked_item_ids }
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
      if (/REQUEST_TIMEOUT|timed out|ComplexityException|budget exhausted/i.test(msg) && attempt < retries) {
        await new Promise(s => setTimeout(s, 1500 * (attempt + 1)));
        continue;
      }
      throw new Error('Monday API: ' + msg);
    }
    return data;
  }
}

// ---- board + column metadata ----------------------------------------------

// The board the Leads "Booking Flow" connection (connect_boards75) points at,
// read from the column's own settings. Never guessed.
let _bfBoard = null;
async function bookingFlowBoardId () {
  if (_bfBoard) return _bfBoard;
  try {
    const data = await mondayQuery(`query {
      boards(ids: ${LEADS_BOARD}) { columns { id title settings_str } }
    }`);
    const cols = data?.data?.boards?.[0]?.columns || [];
    const col  = cols.find(c => c.id === 'connect_boards75') ||
                 cols.find(c => /booking\s*flow/i.test(c.title || ''));
    let ids = [];
    try { ids = JSON.parse(col?.settings_str || '{}').boardIds || []; } catch { /* fall through */ }
    _bfBoard = String(ids[0] || BOOKINGS_BOARD);
  } catch (err) {
    console.warn('bookingFlowBoardId failed, using legacy board:', err.message);
    _bfBoard = String(BOOKINGS_BOARD);
  }
  return _bfBoard;
}

// Column titles per board, so fields resolve by what they are called when an
// id does not match. Cached per board.
const _titlesByBoard = {};
async function boardColumnTitles (boardId) {
  if (_titlesByBoard[boardId]) return _titlesByBoard[boardId];
  try {
    const data = await mondayQuery(`query {
      boards(ids: ${boardId}) { columns { id title type } }
    }`);
    const cols = data?.data?.boards?.[0]?.columns || [];
    _titlesByBoard[boardId] = Object.fromEntries(cols.map(c => [c.id, { title: c.title || '', type: c.type || '' }]));
  } catch (err) {
    console.warn('boardColumnTitles failed for', boardId, ':', err.message);
    _titlesByBoard[boardId] = {};
  }
  return _titlesByBoard[boardId];
}
const columnTitles = () => boardColumnTitles(BOOKINGS_BOARD);

// ---- lookup steps ---------------------------------------------------------

// The lead's name and every board-relation column on it.
async function fetchLeadLinks (leadId) {
  const data = await mondayQuery(`query {
    items(ids: [${Number(leadId)}]) {
      name
      column_values {
        id type
        ... on BoardRelationValue { display_value linked_item_ids }
      }
    }
  }`);
  const it   = data?.data?.items?.[0];
  const cols = it?.column_values || [];
  return {
    name: it?.name || '',
    rels: cols
      .filter(c => c.type === 'board_relation' || (c.linked_item_ids || []).length)
      .map(c => ({
        id:        c.id,
        display:   String(c.display_value || '').trim(),
        linkedIds: (c.linked_item_ids || []).map(String)
      }))
  };
}

async function fetchFullItems (ids) {
  const clean = [...new Set(ids)].map(Number).filter(Boolean).slice(0, 50);
  if (!clean.length) return [];
  const data = await mondayQuery(`query {
    items(ids: [${clean.join(', ')}]) { ${FRAG} }
  }`);
  return data?.data?.items || [];
}

// Which board each item lives on, and nothing else. Cheap enough to run over
// a hundred-plus hop candidates BEFORE the expensive full fetch, so the
// booking cannot be lost to a fetch cap (production hit exactly that: 120
// candidates, only the first 50 fully fetched).
async function boardsOf (ids) {
  const clean = [...new Set(ids)].map(Number).filter(Boolean);
  const out = [];
  for (let i = 0; i < clean.length && i < 400; i += 100) {
    const chunk = clean.slice(i, i + 100);
    const data = await mondayQuery(`query {
      items(ids: [${chunk.join(', ')}]) { id board { id } }
    }`);
    out.push(...(data?.data?.items || []));
  }
  return out;
}

// Relation links of arbitrary items (used for the lead -> contact -> booking
// hop). Light read only.
async function relationLinksOf (ids) {
  const clean = [...new Set(ids)].map(Number).filter(Boolean).slice(0, 25);
  if (!clean.length) return [];
  const data = await mondayQuery(`query {
    items(ids: [${clean.join(', ')}]) { ${LIGHT_FRAG} }
  }`);
  return data?.data?.items || [];
}

function onBoard (items, boardId) {
  return items
    .filter(it => String(it.board?.id || '') === String(boardId))
    .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
}

// Legacy rule query on the Bookings board. Monday does not really filter on
// board-relation columns (0 rows instead of an error), so an empty answer
// proves nothing; kept because when it does match, it is one cheap query.
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

const SCAN_PAGES = 2;   // x100 items; the booking was touched minutes ago

function normName (s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// One cheap pass over the most recently updated rows of the booking flow
// board, collecting two kinds of match:
//   relation : ANY board-relation column on the row links back to the lead
//   name     : the row's name contains the guest's name (or vice versa), for
//              rows nobody linked. Guarded to names of 5+ chars so "Li"
//              cannot match half the board.
async function scanRecent (leadId, leadName, boardId) {
  const wanted   = String(leadId);
  const n        = normName(leadName);
  const nameable = n.length >= 5;
  const relIds   = [];
  const nameIds  = [];
  let cursor = null;

  for (let page = 0; page < SCAN_PAGES; page++) {
    const query = cursor
      ? `query { next_items_page(limit: 100, cursor: ${JSON.stringify(cursor)}) { cursor items { ${LIGHT_FRAG} } } }`
      : `query { boards(ids: ${boardId}) {
           items_page(limit: 100, query_params: { order_by: [{ column_id: "__last_updated__", direction: desc }] }) {
             cursor items { ${LIGHT_FRAG} }
           } } }`;
    const d = await mondayQuery(query);
    const pageData = cursor ? d?.data?.next_items_page : d?.data?.boards?.[0]?.items_page;
    if (!pageData) break;

    for (const it of pageData.items || []) {
      const linksLead = (it.column_values || []).some(c => (c.linked_item_ids || []).map(String).includes(wanted));
      if (linksLead) { relIds.push(String(it.id)); continue; }
      if (nameable) {
        const itemName = normName(it.name);
        if (itemName && (itemName.includes(n) || n.includes(itemName))) nameIds.push(String(it.id));
      }
    }
    if (relIds.length) break;   // a real link beats everything, stop paging
    cursor = pageData.cursor;
    if (!cursor) break;
  }
  return { relIds, nameIds };
}

// Runs the whole ladder. Returns { items, foundVia, rels, trace } where trace
// records every step for ?debug=booking.
async function locateBooking (leadId) {
  const trace = {};
  const bfBoard = await bookingFlowBoardId();
  trace.bookingFlowBoardId = bfBoard;

  let rels = [];
  let leadName = '';
  let linked = [];

  // 1) the lead's own relations
  try {
    const links = await fetchLeadLinks(leadId);
    leadName = links.name;
    rels     = links.rels;
    trace.leadName = leadName;
    linked = await fetchFullItems(rels.flatMap(r => r.linkedIds));
    trace.leadLinkedItems = linked.map(it => ({ itemId: String(it.id), name: it.name, boardId: String(it.board?.id || '') }));
    const direct = onBoard(linked, bfBoard);
    if (direct.length) return { items: direct, foundVia: 'lead-relations', rels, leadName, trace };
  } catch (err) {
    trace.leadRelationsError = err.message;
  }

  // 2) one hop through whatever the lead links to (contact, group booking)
  try {
    const hop = await relationLinksOf(linked.map(it => String(it.id)));
    const hopIds = [...new Set(
      hop.flatMap(h => (h.column_values || []).flatMap(c => (c.linked_item_ids || []).map(String)))
    )].filter(id => id !== String(leadId));
    trace.contactHop = { sources: linked.length, candidates: hopIds.length };
    if (hopIds.length) {
      // Pre-filter by board so a fetch cap can never drop the booking: the
      // OKR and profile-image relations drag in a hundred-plus unrelated
      // items, and only the ones on the booking flow board matter.
      const onBf = (await boardsOf(hopIds))
        .filter(b => String(b.board?.id || '') === String(bfBoard))
        .map(b => String(b.id));
      trace.contactHop.onBookingFlowBoard = onBf.length;
      if (onBf.length) {
        const hopItems = onBoard(await fetchFullItems(onBf), bfBoard);
        trace.contactHop.matches = hopItems.length;
        if (hopItems.length) return { items: hopItems, foundVia: 'contact-hop', rels, leadName, trace };
      }
    }
  } catch (err) {
    trace.contactHop = { error: err.message };
  }

  // 3) legacy rule query, only meaningful on the legacy board
  if (String(bfBoard) === String(BOOKINGS_BOARD)) {
    try {
      const viaRule = await findByRelationRule(leadId);
      trace.rule = { ok: true, matches: viaRule.length };
      if (viaRule.length) return { items: viaRule, foundVia: 'relation-rule', rels, leadName, trace };
    } catch (err) {
      trace.rule = { ok: false, error: err.message };
    }
  }

  // 4 + 5) recent scan: linked rows first, then name matches
  try {
    const { relIds, nameIds } = await scanRecent(leadId, leadName, bfBoard);
    trace.scan = { ok: true, relationMatches: relIds.length, nameMatches: nameIds.length };
    if (relIds.length) {
      const items = onBoard(await fetchFullItems(relIds), bfBoard);
      if (items.length) return { items, foundVia: 'recent-scan', rels, leadName, trace };
    }
    if (nameIds.length) {
      const items = onBoard(await fetchFullItems(nameIds), bfBoard);
      if (items.length) return { items, foundVia: 'name-match', rels, leadName, trace };
    }
  } catch (err) {
    trace.scan = { ok: false, error: err.message };
  }

  return { items: [], foundVia: null, rels, leadName, trace };
}

// ---- value resolution -----------------------------------------------------

// Value of a column whatever its type: relation / formula / mirror columns
// answer on display_value, status on label, the rest on text.
function valueOf (c) {
  if (!c) return '';
  const v = String(c.display_value || c.label || c.text || '').trim();
  // Monday returns UNEVALUATED formula columns as the literal string "null"
  // (seen in production on formula2: it parsed to NaN -> commission £0 and
  // masked the real value sitting in Rev to Google). Treat it as empty.
  return v === 'null' || v === 'undefined' ? '' : v;
}

// Apartment Agreed on the booking row: by id, then by the column titled
// "Apartment Agreed", then any apartment column holding a value, preferring a
// board relation over a text or dropdown field like "Apartment Type".
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

  const loose = Object.keys(cv)
    .filter(id => /apartment|apt/i.test(titles[id]?.title || ''))
    .sort((a, b) => (titles[b]?.type === 'board_relation' ? 1 : 0) - (titles[a]?.type === 'board_relation' ? 1 : 0));
  for (const id of loose) {
    const v = valueOf(cv[id]);
    if (v) return v;
  }
  return '';
}

// The agreed apartment can live on the LEAD as a board relation instead of on
// the booking row: connect_boards25 (the id Alex gave), or a lead column whose
// title mentions an apartment.
async function apartmentFromLeadRelations (rels) {
  const withValue = (rels || []).filter(r => r.display);
  if (!withValue.length) return '';
  const byId = withValue.find(r => r.id === 'connect_boards25');
  if (byId) return byId.display;
  const titles = await boardColumnTitles(LEADS_BOARD);
  const byTitle = withValue.find(r => /apartment|apt/i.test(titles[r.id]?.title || ''));
  return byTitle ? byTitle.display : '';
}

function mapBooking (item, titles = {}) {
  const cv = {};
  (item.column_values || []).forEach(c => { cv[c.id] = c; });

  // date6 is the check-in the sales team fills in on the booking flow. date69
  // is the one the commission formula reads. Prefer date6, fall back so an
  // empty column never blanks the row.
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
    salesperson: valueOf(cv.people98),
    apartment:  apartment || '',
    checkIn,
    checkOut,
    nights:     nights == null ? '' : nights,
    nightlyRate: rate,
    commission: commission.value,
    commissionEstimated: commission.estimated,
    status:     cv.status?.label || txt(cv.status) || '',
    confirmed:  !!txt(cv.date9),
    url:        item.url || `https://${MONDAY_SLUG}.monday.com/boards/${String(item.board?.id || BOOKINGS_BOARD)}/pulses/${item.id}`
  };
}

// { value: number|null, estimated: boolean }
function resolveCommission (cv) {
  // A zero at any stage means "not filled in yet", not a free booking: Rev to
  // Google defaults to 0, and the recompute multiplies by an empty commission
  // percent. Fall through to the next source, and to null (which the email
  // renders as "<salesperson> has not filled this in yet") if all are zero.
  const formula = numOf(valueOf(cv.formula2));
  if (formula > 0) return { value: formula, estimated: false };

  const stored = numOf(txt(cv.numeric_mm1ge9h4));
  if (stored > 0) return { value: stored, estimated: false };

  const calc = computeFormula2(cv);
  if (calc != null && calc > 0) return { value: calc, estimated: true };

  return { value: null, estimated: false };
}

// ---- public API -----------------------------------------------------------

// Returns the booking detail for a lead, or null when nothing is found.
// Never throws: a Monday hiccup must not stop the email.
async function fetchBookingForLead (leadId) {
  let located;
  try {
    located = await locateBooking(leadId);
  } catch (err) {
    console.warn('locateBooking failed:', err.message);
    return null;
  }

  const { items, rels } = located;
  let booking = null;
  if (items.length) {
    const titles = await boardColumnTitles(String(items[0].board?.id || BOOKINGS_BOARD));
    booking = mapBooking(items[0], titles);
  }

  // The apartment can be agreed on the lead rather than the booking row. Fill
  // it from the lead's own relations, rendering an apartment-only block when
  // there is no booking row at all: better than showing nothing.
  if (!booking || !booking.apartment) {
    try {
      const apartment = await apartmentFromLeadRelations(rels);
      if (apartment) {
        booking = booking
          ? { ...booking, apartment }
          : {
              itemId: '', name: '', salesperson: '', apartment,
              checkIn: '', checkOut: '', nights: '',
              nightlyRate: null, commission: null, commissionEstimated: false,
              status: '', confirmed: false, url: ''
            };
      }
    } catch (err) {
      console.warn('apartmentFromLeadRelations failed:', err.message);
    }
  }
  return booking;
}

// Diagnostic for /api/test-lead-qualified?debug=booking&itemId=<leadId>.
// Dumps the full lookup trace, the winning row's populated columns (id,
// title, type, value), and the block as it would render.
async function debugBookingForLead (leadId) {
  const out = { leadId: String(leadId) };

  let located;
  try {
    located = await locateBooking(leadId);
  } catch (err) {
    out.error = err.message;
    return out;
  }

  out.foundVia = located.foundVia;
  Object.assign(out, located.trace);

  // Decorate the lead's relations with their column titles.
  try {
    const leadTitles = await boardColumnTitles(LEADS_BOARD);
    out.leadRelations = located.rels.map(r => ({
      columnId: r.id,
      title:    leadTitles[r.id]?.title || '',
      display:  r.display,
      linkedIds: r.linkedIds
    }));
  } catch { /* titles are decoration */ }

  if (located.items.length) {
    const item   = located.items[0];
    const titles = await boardColumnTitles(String(item.board?.id || BOOKINGS_BOARD));
    out.item = { id: String(item.id), name: item.name, boardId: String(item.board?.id || '') };
    out.columnsWithValues = (item.column_values || [])
      .map(c => ({ id: c.id, title: titles[c.id]?.title || '', type: c.type || titles[c.id]?.type || '', value: valueOf(c) }))
      .filter(c => c.value !== '');
  } else {
    out.note = 'No booking row found on board ' + out.bookingFlowBoardId +
               ' by lead relations, contact hop, rule, scan, or name match. ' +
               'If the row exists, it is not linked and its name does not contain the guest name.';
  }

  out.rendered = await fetchBookingForLead(leadId);
  return out;
}

// Reverse diagnostic: dump a KNOWN booking row by its item id, showing which
// board it lives on, every relation column and what it links to, and how the
// email would render it. Use when the lead-side search finds nothing: it
// answers "how is this row actually connected, and to what".
async function debugBookingRow (bookingId) {
  const items = await fetchFullItems([bookingId]);
  if (!items.length) return { bookingId: String(bookingId), error: 'item not found (or the API key cannot see it)' };
  const it      = items[0];
  const boardId = String(it.board?.id || '');
  const titles  = await boardColumnTitles(boardId);
  return {
    bookingId: String(it.id),
    name:      it.name,
    boardId,
    isBookingFlowBoard: boardId === String(await bookingFlowBoardId()),
    relations: (it.column_values || [])
      .filter(c => (c.linked_item_ids || []).length)
      .map(c => ({
        columnId:  c.id,
        title:     titles[c.id]?.title || '',
        display:   String(c.display_value || '').trim(),
        linkedIds: (c.linked_item_ids || []).map(String)
      })),
    columnsWithValues: (it.column_values || [])
      .map(c => ({ id: c.id, title: titles[c.id]?.title || '', type: c.type || titles[c.id]?.type || '', value: valueOf(c) }))
      .filter(c => c.value !== ''),
    rendered: mapBooking(it, titles)
  };
}

module.exports = {
  BOOKINGS_BOARD,
  LEADS_BOARD,
  BOOKING_COLS,
  bookingFlowBoardId,
  fetchBookingForLead,
  debugBookingForLead,
  debugBookingRow,
  locateBooking,
  mapBooking,
  resolveApartment,
  resolveCommission,
  columnTitles,
  boardColumnTitles
};
