// test-lead-qualified.js
//
// Preview / test harness for the redesigned "Lead Qualified" staff email,
// using REAL data from the Monday Leads board (2171015719).
//
// Usage (after deploy, with MONDAY_API_KEY set in Vercel):
//   GET /api/test-lead-qualified?itemId=123456789
//        -> renders the email for that lead and returns the HTML (view in browser)
//   GET /api/test-lead-qualified
//        -> auto-picks the most recently updated lead whose status is Qualified
//   GET /api/test-lead-qualified?itemId=123&send=you@studentluxe.co.uk
//        -> also sends a real test email via Resend
//
// Optional overrides (the live webhook will supply these from the trigger):
//   &by=Sofia%20Marchetti     who qualified it (defaults to the assignee)
//   &qualifiedAt=2026-06-26T14:32:00Z   defaults to the item's updated_at
//
// This is a TEST endpoint. The production path will be a Monday webhook that
// builds the same `lead` object and calls renderLeadQualified() + Resend.

const { renderLeadQualified } = require('./_lead-qualified-email');

const MONDAY_API   = 'https://api.monday.com/v2';
const RESEND_API   = 'https://api.resend.com/emails';
const LEADS_BOARD  = 2171015719;
const MONDAY_SLUG  = process.env.MONDAY_ACCOUNT_SLUG || 'student-luxe';

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
  'text43__1',         // adgroup
  'long_text__1',      // visited paths
  'people_1',          // assigned to
  'status',            // lead status
  'long_text6'         // sales progress notes
];

module.exports = async function handler(req, res) {
  try {
    if (!process.env.MONDAY_API_KEY) {
      return res.status(500).send('MONDAY_API_KEY is not set');
    }

    const q = req.query || {};

    // Optional guard: if TEST_ENDPOINT_KEY is set in Vercel, require ?key= to match.
    // Leave it unset while testing, then set it (or delete this endpoint) afterwards.
    if (process.env.TEST_ENDPOINT_KEY && q.key !== process.env.TEST_ENDPOINT_KEY) {
      return res.status(401).send('Unauthorized');
    }

    const item = q.itemId ? await fetchItem(q.itemId) : await fetchLatestQualified();
    if (!item) {
      return res.status(404).send(q.itemId
        ? `No Monday item found for id ${q.itemId}`
        : 'No lead with status "Qualified" found on the board');
    }

    const lead = mapItemToLead(item, q);
    const { subject, html } = renderLeadQualified(lead);

    let sent = null;
    if (q.send) {
      sent = await sendResend(q.send, subject, html);
    }

    // Return the rendered email so it can be eyeballed in a browser.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Lead-Item-Id', String(item.id));
    res.setHeader('X-Email-Subject', subject);
    if (sent) res.setHeader('X-Resend-Id', sent.id || 'sent');
    return res.status(200).send(html);

  } catch (err) {
    console.error('test-lead-qualified error:', err);
    return res.status(500).send('Error: ' + err.message);
  }
};

// ---- Monday fetch ---------------------------------------------------------

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

const colsArg = COLS.map(c => `"${c}"`).join(', ');

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
  // Pull the most recently updated items and pick the first one marked Qualified.
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

// ---- mapping --------------------------------------------------------------

function colText(item, id) {
  const c = (item.column_values || []).find(cv => cv.id === id);
  return (c && c.text ? c.text : '').trim();
}

function nightsBetween(a, b) {
  if (!a || !b) return '';
  const ms = new Date(b) - new Date(a);
  const n = Math.round(ms / 86400000);
  return n > 0 ? n : '';
}

function parseRate(text) {
  if (!text) return 0;
  const m = String(text).replace(/[, ]/g, '').match(/\d+(\.\d+)?/);
  return m ? Math.round(parseFloat(m[0])) : 0;
}

function splitPaths(text) {
  if (!text) return [];
  return String(text).split(/\s*(?:→|->|\n|\|)\s*/).map(s => s.trim()).filter(Boolean);
}

function splitNotes(text) {
  if (!text) return [];
  const lines = String(text).split(/\n+/).map(s => s.trim()).filter(Boolean);
  return lines.map((line, i) => ({
    text: line,
    kind: lines.length === 1 ? 'qualified' : i === 0 ? 'open' : i === lines.length - 1 ? 'qualified' : 'mid'
  }));
}

function mapItemToLead(item, q) {
  const first   = colText(item, 'text37');
  const last    = colText(item, 'text60');
  const name    = item.name || `${first} ${last}`.trim();
  const checkIn  = colText(item, 'date47');
  const checkOut = colText(item, 'date_1');
  const assigned = colText(item, 'people_1');
  const source   = colText(item, 'color_mkxk8y67');
  const campaign = colText(item, 'text_mm1c3b5w');
  const adgroup  = colText(item, 'text43__1');
  const city     = colText(item, 'text8');
  const areas    = colText(item, 'dropdown19');
  const phone    = colText(item, 'phone_1');

  return {
    guestName:    name,
    contactPhone: phone,
    contactEmail: colText(item, 'email'),

    createdAt:    q.createdAt   || item.created_at,
    qualifiedAt:  q.qualifiedAt || item.updated_at,
    qualifiedBy:  q.by || assigned || 'Reservations team',
    assignedTo:   assigned || 'Unassigned',
    assignedToRole: 'Reservations',

    source:       source || 'Unknown',
    campaign:     [campaign, adgroup].filter(Boolean).join(' · '),

    nights:       nightsBetween(checkIn, checkOut),
    weeklyRate:   parseRate(colText(item, 'budget_per_week')),
    budgetNote:   '',
    guests:       '',

    checkIn,
    checkOut,
    location:     [city, areas].filter(Boolean).join(' · ') || 'Not specified',

    visitedPaths: splitPaths(colText(item, 'long_text__1')),
    notes:        splitNotes(colText(item, 'long_text6')),

    mondayUrl:    `https://${MONDAY_SLUG}.monday.com/boards/${LEADS_BOARD}/pulses/${item.id}`,
    whatsappUrl:  'https://wa.me/' + phone.replace(/\D/g, '')
  };
}

// ---- Resend ---------------------------------------------------------------

async function sendResend(to, subject, html) {
  const r = await fetch(RESEND_API, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    `${process.env.FROM_NAME || 'Student Luxe'} <${process.env.FROM_EMAIL || 'reservations@studentluxe.co.uk'}>`,
      to:      [to],
      subject: '[TEST] ' + subject,
      html
    })
  });
  if (!r.ok) throw new Error(`Resend error ${r.status}: ${await r.text()}`);
  return r.json();
}
