// ============================================================
//  Guest Services portal, sign in.
//  POST /api/guest-session  { ref, surname }
//    200 { token, expiresIn, guest: { first, ref, city, checkIn } }
//    401 generic mismatch (never says which half was wrong)
//    403 no live booking on that reference
//    429 rate limited
//
//  THE REFERENCE
//  What guests see as "Ref #" is the LEAD's Monday item id: the
//  Leads board column `item_id7` ("Ref # (AO in use)"), surfaced on
//  the Booking Flow board as the mirror column `mirror8`.
//
//  So the lookup goes lead-first, not booking-first:
//    digits(ref) -> lead item -> linked bookings -> live booking?
//  A mirror column cannot be filtered with items_page query_params
//  and returns its value in `display_value` rather than `text`, so
//  searching the Booking Flow board by `mirror8` is not an option.
//  Fetching the lead by id costs one call and no search at all.
//
//  Fallback: if the id is not a lead, it is tried as a Booking Flow
//  item id, which covers the booking-side "Alex Booking Ref" column
//  (`pulse_id_mm3t29qp`) if that ever becomes the number we send.
//
//  ENV
//    GUEST_PORTAL_SECRET     required, HMAC key for session tokens
//    GUEST_LEADS_BOARDS      default "2171015719,3265428349"
//    GUEST_BOOKING_BOARDS    default "2171015589"
//    GUEST_LEAD_BOOKING_RELATIONS  default "connect_boards75"
//    GUEST_ACCESS_GRACE_DAYS days after check out that access survives,
//                            default 30. Booking Stage has no checked out
//                            label, so this is what stops ex-guests.
//    GUEST_BLOCKED_STATUSES  exact Booking Stage labels that cannot
//                            sign in. Default
//                            "Lost Booking,Cancelled Booking,Pending Booking"
//                            Exact, not substring: "Extensions - Pending"
//                            is a real guest and must stay allowed.
//    GUEST_PORTAL_ORIGINS    CORS allowlist
// ============================================================

const {
  applyCors, issueToken, isRateLimited, bumpRateLimit, clientIp,
  monday, gqlString, normalise, surnameMatches
} = require('./_guest-auth.js');
const { logError } = require('./_errlog.js');

function idList (envName, fallback) {
  return String(process.env[envName] || fallback)
    .split(',').map(s => s.trim()).filter(Boolean);
}

const LEADS_BOARDS   = () => idList('GUEST_LEADS_BOARDS', '2171015719,3265428349');
const BOOKING_BOARDS = () => idList('GUEST_BOOKING_BOARDS', '2171015589');
const LEAD_BOOKING_RELATIONS = () => idList('GUEST_LEAD_BOOKING_RELATIONS', 'connect_boards75');

function blockedStatuses () {
  return String(process.env.GUEST_BLOCKED_STATUSES ||
    'Lost Booking,Cancelled Booking,Pending Booking')
    .split(',').map(s => normalise(s)).filter(Boolean);
}

// Lead columns: First Name, Last Name, City, Ref #
const LEAD_COLS    = '["text37", "text60", "text8", "item_id7"]';
// Booking columns: Booking Stage, Check In, Check Out
const BOOKING_COLS = '["status", "date69", "date_1"]';

// How long after a stay ends the portal stays open. Booking Stage has no
// "checked out" label, so without this an old Confirmed Booking would let
// someone who stayed two years ago keep pulling live partner codes.
function graceDays () {
  var n = Number(process.env.GUEST_ACCESS_GRACE_DAYS);
  return isNaN(n) ? 30 : n;
}

const BOOKING_FIELDS = `
  id
  name
  board { id }
  column_values(ids: ${BOOKING_COLS}) {
    id text
    ... on StatusValue { label }
  }
`;

// Mirror and lookup columns answer on display_value, status columns on
// label, everything else on text. Reading only `text` is why mirrors
// silently come back null.
function colValue (item, id) {
  var cols = (item && item.column_values) || [];
  for (var i = 0; i < cols.length; i++) {
    if (cols[i].id === id) {
      return cols[i].label || cols[i].display_value || cols[i].text || '';
    }
  }
  return '';
}

function isBlocked (statusLabel) {
  var s = normalise(statusLabel);
  if (!s) return false;
  return blockedStatuses().indexOf(s) !== -1;
}

// Monday dates are plain "YYYY-MM-DD" strings, so string comparison is
// date comparison and no parsing is needed.
function isoDaysAgo (days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

// Current means: the stay has not ended more than the grace period ago.
// Check out (date_1) is the honest end of a stay; some rows only carry a
// check in (date69), and a booking with neither date is treated as current
// rather than locking out a guest over a blank cell.
function isCurrent (booking) {
  var cutoff   = isoDaysAgo(graceDays());
  var checkOut = colValue(booking, 'date_1');
  if (checkOut) return checkOut >= cutoff;
  var checkIn = colValue(booking, 'date69');
  if (checkIn) return checkIn >= cutoff;
  return true;
}

// A lead can hold several bookings (extensions, rebookings, a cancelled one
// alongside a live one). Access is granted on the best live booking, and
// "best" means the latest check in, which is the stay a guest signing in
// today actually cares about.
function pickBooking (bookings) {
  var live = (bookings || []).filter(function (b) {
    return b && !isBlocked(colValue(b, 'status')) && isCurrent(b);
  });
  if (!live.length) return null;
  live.sort(function (a, b) {
    return String(colValue(b, 'date69')).localeCompare(String(colValue(a, 'date69')));
  });
  return live[0];
}

async function fetchLead (itemId) {
  var relations = LEAD_BOOKING_RELATIONS()
    .map(function (id) { return '"' + id + '"'; }).join(', ');

  var data = await monday(`
    query {
      items(ids: [${gqlString(itemId)}]) {
        id
        name
        board { id }
        column_values(ids: ${LEAD_COLS}) { id text }
        bookings: column_values(ids: [${relations}]) {
          id
          ... on BoardRelationValue {
            linked_items { ${BOOKING_FIELDS} }
          }
        }
      }
    }
  `);
  return (data.items || [])[0] || null;
}

async function fetchBooking (itemId) {
  var data = await monday(`
    query {
      items(ids: [${gqlString(itemId)}]) {
        ${BOOKING_FIELDS}
        lead: column_values(ids: ["link_to_leads26"]) {
          id
          ... on BoardRelationValue {
            linked_items {
              id
              name
              board { id }
              column_values(ids: ${LEAD_COLS}) { id text }
            }
          }
        }
      }
    }
  `);
  return (data.items || [])[0] || null;
}

function onBoard (item, boards) {
  return !!item && !!item.board && boards.indexOf(String(item.board.id)) !== -1;
}

function linkedItems (item, key) {
  var group = (item && item[key]) || [];
  var out = [];
  group.forEach(function (col) {
    (col.linked_items || []).forEach(function (li) { out.push(li); });
  });
  return out;
}

/**
 * Resolve a typed reference into { lead, booking } or null.
 * Lead first, because the reference guests hold is the lead item id.
 */
async function resolve (itemId) {
  var lead = await fetchLead(itemId);

  if (onBoard(lead, LEADS_BOARDS())) {
    var bookings = linkedItems(lead, 'bookings').filter(function (b) {
      return onBoard(b, BOOKING_BOARDS());
    });
    return { lead: lead, booking: pickBooking(bookings) };
  }

  // Not a lead. Try the same number as a Booking Flow item id.
  var booking = await fetchBooking(itemId);
  if (!onBoard(booking, BOOKING_BOARDS())) return null;

  var leads = linkedItems(booking, 'lead');
  return {
    lead: leads[0] || null,
    booking: isBlocked(colValue(booking, 'status')) ? null : booking,
    bookingRow: booking
  };
}

module.exports = async function handler (req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Only failures count against the limits. A shared building or campus
  // NAT can send a dozen genuine guests from one address, and they should
  // never spend the budget that exists to stop guessers.
  let spend = async () => {};

  const fail = async () => {
    await spend();
    return res.status(401).json({
      error: 'We could not match those details. Check the reference and surname exactly as they appear on your confirmation.'
    });
  };

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const ref     = String(body.ref || '').trim().slice(0, 40);
    const surname = String(body.surname || '').trim().slice(0, 60);
    if (!ref || !surname) return fail();

    // Guests paste the number with or without decoration ("SL-9038612423",
    // "Ref 9038612423"), so only the digits count. Leading zeros are
    // dropped: Monday ids never carry them, and they are not a valid id.
    const itemId = ref.replace(/\D/g, '').replace(/^0+/, '').slice(0, 18);
    if (!itemId) return fail();

    // Two limits: one per IP (someone spraying references), one per
    // reference (someone brute forcing surnames on a ref they know).
    const ip = clientIp(req);
    spend = async () => {
      await bumpRateLimit('ip:' + ip, 15 * 60);
      await bumpRateLimit('ref:' + itemId, 60 * 60);
    };

    if (await isRateLimited('ip:' + ip, 10)) {
      return res.status(429).json({ error: 'Too many attempts. Try again in fifteen minutes.' });
    }
    if (await isRateLimited('ref:' + itemId, 20)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }

    const found = await resolve(itemId);
    if (!found) return fail();

    const lead = found.lead;
    const names = [
      lead ? colValue(lead, 'text60') : '',
      lead ? colValue(lead, 'text37') : '',
      lead ? lead.name : '',
      found.bookingRow ? found.bookingRow.name : ''
    ];
    // Surname is checked before any booking state is revealed, so a wrong
    // surname and a cancelled booking are indistinguishable from outside.
    if (!surnameMatches(names, surname)) return fail();

    if (!found.booking) {
      await spend();
      return res.status(403).json({
        error: 'We could not find a current booking on that reference. Message the guest team if that looks wrong.'
      });
    }

    const guest = {
      id:      found.booking.id,
      ref:     (lead && colValue(lead, 'item_id7')) || itemId,
      first:   (lead && colValue(lead, 'text37')) ||
               String((lead && lead.name) || '').split(/[\s,]+/)[0] || '',
      city:    (lead && colValue(lead, 'text8')) || '',
      checkIn: colValue(found.booking, 'date69') || ''
    };

    const { token, expiresIn } = issueToken(guest);
    return res.status(200).json({ token, expiresIn, guest });

  } catch (err) {
    logError('guest-session', err);
    return res.status(500).json({ error: 'Something went wrong. Try again shortly.' });
  }
};
