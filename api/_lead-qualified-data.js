// _lead-qualified-data.js
//
// Shared Monday fetch + column mapping for the "Lead Qualified" email.
// Used by both api/test-lead-qualified.js (preview) and
// api/lead-qualified-webhook.js (the live Monday automation), so the two
// can never drift. Edit the column mapping here, once.

const MONDAY_API  = 'https://api.monday.com/v2';
const RESEND_API  = 'https://api.resend.com/emails';
const LEADS_BOARD = 2171015719;
const MONDAY_SLUG = process.env.MONDAY_ACCOUNT_SLUG || 'student-luxe';

// Leads board column ids (confirmed against api/submit-enquiry.js)
const COLS = [
  'text37',            // first name
  'text60',            // last name
  'email',
  'phone_1',
  'date47',            // check-in
  'date_1',            // check-out
  'budget_per_week',
  'text8',             // city / location
  'dropdown19',        // areas
  'color_mkxk8y67',    // lead source
  'dropdown_mkxkfbff', // lead channel
  'text_mm1c3b5w',     // campaign
  'text3__1',          // utm_term
  'text_mm4nkhk0',     // first channel (first touch)
  'long_text__1',      // visited paths
  'people_1',          // assigned to
  'status',            // lead status
  'long_text6'         // sales progress notes
];
const colsArg = COLS.map(c => `"${c}"`).join(', ');

async function mondayQuery(query, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(MONDAY_API, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
      body:    JSON.stringify({ query })
    });
    const text = await r.text();
    if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) {
      if (attempt < retries) { await new Promise(s => setTimeout(s, 1000)); continue; }
      throw new Error('Monday API returned non-JSON: ' + text.substring(0, 80));
    }
    const data = JSON.parse(text);
    if (data.errors) throw new Error('Monday API: ' + JSON.stringify(data.errors));
    return data;
  }
}

async function fetchItem(itemId) {
  const data = await mondayQuery(`query {
    items(ids: [${Number(itemId)}]) {
      id name created_at updated_at
      column_values(ids: [${colsArg}]) { id text value }
    }
  }`);
  return data?.data?.items?.[0] || null;
}

async function fetchLatestQualified() {
  // Most recently updated item whose status is Qualified.
  const data = await mondayQuery(`query {
    boards(ids: [${LEADS_BOARD}]) {
      items_page(limit: 100, query_params: { order_by: [{ column_id: "__last_updated__", direction: desc }] }) {
        items {
          id name created_at updated_at
          column_values(ids: [${colsArg}]) { id text value }
        }
      }
    }
  }`);
  const items = data?.data?.boards?.[0]?.items_page?.items || [];
  return items.find(it => /qualif/i.test(colText(it, 'status'))) || null;
}

// Raw activity-log events for a single item, used to derive stage timestamps
// (assigned / approached / in progress / high potential). Monday keeps only the
// current value of each column, so the change history is the only source.
// created_at is a Monday "17-digit" timestamp = 1/10,000 ms units.
async function fetchItemActivity(itemId, sinceISO) {
  const fromArg = sinceISO ? `, from: "${new Date(sinceISO).toISOString()}"` : '';
  const out = [];
  for (let page = 1; page <= 8; page++) {
    const data = await mondayQuery(`query {
      boards(ids: [${LEADS_BOARD}]) {
        activity_logs(limit: 200, page: ${page}${fromArg}) {
          event data created_at
        }
      }
    }`);
    const logs = data?.data?.boards?.[0]?.activity_logs || [];
    if (!logs.length) break;
    for (const l of logs) {
      let d; try { d = JSON.parse(l.data); } catch { continue; }
      if (String(d.pulse_id ?? d.pulseId ?? '') !== String(itemId)) continue;
      out.push({
        event:     l.event,
        columnId:  d.column_id || d.columnId || '',
        label:     (d.value && (d.value.label?.text ?? d.value.label)) ?? '',
        createdAt: new Date(Number(l.created_at) / 10000).toISOString(),
        rawCreatedAt: l.created_at,
        data:      d
      });
    }
    if (logs.length < 200) break;
  }
  out.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return out;
}

// Derive the stage timeline from an item's activity log. Matches stage labels
// wherever they appear (status column, assignment column, high-potential column).
// Stages a lead never hit are simply omitted. Sorted chronologically.
function buildTimeline(events, createdAt) {
  // Activity events carry their timestamp as `createdAt` (ISO). Accept `at` too
  // so hand-built test events keep working.
  const tsOf = ev => ev.createdAt || ev.at || null;
  const firstAt = re => {
    const e = events.find(ev => re.test(String(ev.label || '')));
    return e ? tsOf(e) : null;
  };
  const assignedAt =
    firstAt(/^assigned$/i) ||
    tsOf(events.find(ev => ev.columnId === 'people_1') || {});

  const qualifiedAt  = firstAt(/qualified/i);
  const highPotRaw   = firstAt(/high.?potential/i);
  // Every lead is auto-marked High Potential the moment it is Qualified (a
  // Monday automation), so that event is noise. Only surface High Potential
  // when it was set strictly BEFORE qualification: a genuine early signal.
  const highPotAt = (highPotRaw && (!qualifiedAt || new Date(highPotRaw) < new Date(qualifiedAt)))
    ? highPotRaw : null;

  const rows = [
    { label: 'Created',        at: createdAt,                tone: 'muted' },
    { label: 'Assigned',       at: assignedAt,               tone: 'muted' },
    { label: 'Approached',     at: firstAt(/approach/i),     tone: 'gold'  },
    { label: 'In progress',    at: firstAt(/in.?progress/i), tone: 'gold'  },
    { label: 'High potential', at: highPotAt,                tone: 'amber' },
    { label: 'Qualified',      at: qualifiedAt,              tone: 'green' }
  ].filter(r => r.at);

  rows.sort((a, b) => new Date(a.at) - new Date(b.at));
  return rows;
}

async function fetchTimeline(itemId, createdAt) {
  try {
    const events = await fetchItemActivity(itemId, createdAt);
    return buildTimeline(events, createdAt);
  } catch (e) {
    console.warn('fetchTimeline failed:', e.message);
    return [];
  }
}

async function resolveUserName(userId) {
  if (!userId) return '';
  try {
    const data = await mondayQuery(`query { users(ids: [${Number(userId)}]) { name } }`);
    return (data?.data?.users?.[0]?.name || '').trim();
  } catch {
    return '';
  }
}

// ---- mapping --------------------------------------------------------------

function colText(item, id) {
  const c = (item.column_values || []).find(cv => cv.id === id);
  return (c && c.text ? c.text : '').trim();
}

function nightsBetween(a, b) {
  if (!a || !b) return '';
  const n = Math.round((new Date(b) - new Date(a)) / 86400000);
  return n > 0 ? n : '';
}

function parseRate(text) {
  if (!text) return 0;
  const m = String(text).replace(/[, ]/g, '').match(/\d+(\.\d+)?/);
  return m ? Math.round(parseFloat(m[0])) : 0;
}

// The Leads board "visited paths" column separates entries with 👉 (and sometimes
// arrows/newlines) and the first entry is usually the full landing URL with a
// gclid/UTM query string. Split on those separators and reduce each entry to a
// clean path so a giant unbreakable URL cannot blow out the email width.
function cleanPathEntry(s) {
  s = String(s).trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\//i, '');           // strip protocol
  s = s.replace(/\?.*$/, '');                    // strip query string (utm/gclid noise)
  s = s.replace(/^[^/\s]*\.[^/\s]+(?=\/)/, '');  // strip leading host before a path
  return s.trim();
}

function splitPaths(text) {
  if (!text) return [];
  return String(text)
    .split(/\s*(?:👉|➡️?|→|->|\n|\|)\s*/u)
    .map(cleanPathEntry)
    .filter(Boolean);
}

function splitNotes(text) {
  if (!text) return [];
  const lines = String(text).split(/\n+/).map(s => s.trim()).filter(Boolean);
  return lines.map((line, i) => ({
    text: line,
    kind: lines.length === 1 ? 'qualified' : i === 0 ? 'open' : i === lines.length - 1 ? 'qualified' : 'mid'
  }));
}

// overrides: { createdAt, qualifiedAt, by }  (supplied by the webhook trigger
// or test query params; otherwise sensible fallbacks are used)
function mapItemToLead(item, overrides = {}) {
  const first    = colText(item, 'text37');
  const last     = colText(item, 'text60');
  const name     = item.name || `${first} ${last}`.trim();
  const checkIn  = colText(item, 'date47');
  const checkOut = colText(item, 'date_1');
  const assigned = colText(item, 'people_1');
  const source   = colText(item, 'color_mkxk8y67');
  const campaign = colText(item, 'text_mm1c3b5w');
  const term     = colText(item, 'text3__1');      // utm_term (use instead of adgroup)
  const firstCh  = colText(item, 'text_mm4nkhk0'); // first channel / first touch
  const city     = colText(item, 'text8');
  const areas    = colText(item, 'dropdown19');
  const phone    = colText(item, 'phone_1');

  return {
    guestName:    name,
    contactPhone: phone,
    contactEmail: colText(item, 'email'),

    createdAt:    overrides.createdAt   || item.created_at,
    qualifiedAt:  overrides.qualifiedAt || item.updated_at,
    qualifiedBy:  overrides.by || assigned || 'Reservations team',
    assignedTo:   assigned || 'Unassigned',
    assignedToRole: 'Reservations',

    source:           source || 'Unknown',
    sourceFirstTouch: firstCh,
    campaign:         [campaign, term].filter(Boolean).join(' · '),

    nights:       nightsBetween(checkIn, checkOut),
    weeklyRate:   parseRate(colText(item, 'budget_per_week')),
    budgetNote:   '',
    guests:       '',

    checkIn,
    checkOut,
    location:     [city, areas].filter(Boolean).join(' · ') || 'Not specified',

    visitedPaths: splitPaths(colText(item, 'long_text__1')),
    notes:        splitNotes(colText(item, 'long_text6')),

    mondayUrl:    `https://${MONDAY_SLUG}.monday.com/boards/${LEADS_BOARD}/pulses/${item.id}`
  };
}

// ---- Resend ---------------------------------------------------------------

// to: string or array of recipient addresses
async function sendEmail({ to, subject, html, testPrefix = false }) {
  const recipients = Array.isArray(to) ? to : [to];
  const r = await fetch(RESEND_API, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    `${process.env.FROM_NAME || 'Student Luxe'} <${process.env.FROM_EMAIL || 'reservations@studentluxe.co.uk'}>`,
      to:      recipients,
      subject: testPrefix ? '[TEST] ' + subject : subject,
      html
    })
  });
  if (!r.ok) throw new Error(`Resend error ${r.status}: ${await r.text()}`);
  return r.json();
}

module.exports = {
  LEADS_BOARD,
  fetchItem,
  fetchLatestQualified,
  fetchItemActivity,
  fetchTimeline,
  buildTimeline,
  resolveUserName,
  mapItemToLead,
  sendEmail
};
