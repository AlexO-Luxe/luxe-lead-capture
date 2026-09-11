// ============================================================
//  Booker profile: what the leads that actually booked look like.
//
//  "When a booking comes in, find more people like that lead." Google's
//  side of that is Customer Match plus the Step 4 value upload, both of
//  which already fire from submit-booking. This is our side: every booked
//  lead carries city, university, nationality, geo country, device, budget
//  band, apartment type, campaign, first campaign, search term, landing
//  page and channel in Monday. Compared against every lead in the same
//  window, the fields where bookers over-index are the levers: countries
//  to bid up, search themes to add, landing pages to point at, universities
//  to build for, budget bands that never book.
//
//  Two outputs, both consumed by api/pmax-review.js:
//    bookerProfileSections(days) -> [todoSection, profileSection]
//  The to-do card is a short list of concrete Ads actions derived from the
//  profile. The profile card is the evidence behind it.
//
//  Bookings are sparse, so the default window is 180 days. Small counts are
//  shown as counts and never dressed up as percentages on their own.
// ============================================================

const MONDAY_API     = 'https://api.monday.com/v2';
const LEADS_BOARD    = 2171015719;
const BOOKINGS_BOARD = 2171015589;

const { bookingValue } = require('./_booking-value.js');
const { table, th, td, emptyRow, esc, BRAND } = require('./_digest.js');

const LEAD_COLS = [
  'text8', 'text_mknfnmsb', 'text9__1', 'text_mm4n61bc', 'text_mm4n6987', 'budget_per_week',
  'apt_type_mkmn4bgg', 'text_mm1c3b5w', 'text_mm4ntp4n', 'text3__1', 'text_mm1jhhe7',
  'color_mkxk8y67', 'dropdown_mkxkfbff', 'text_mm4nkhk0', 'date47', 'date_1', 'status_11'
];

// Dimension -> lead column. Order is display order.
const DIMENSIONS = [
  { key: 'country',      label: 'Country (geo)',        col: 'text_mm4n61bc' },
  { key: 'nationality',  label: 'Nationality',          col: 'text9__1' },
  { key: 'city',         label: 'City',                 col: 'text8' },
  { key: 'university',   label: 'University',           col: 'text_mknfnmsb' },
  { key: 'budget',       label: 'Budget band',          col: 'budget_per_week' },
  { key: 'aptType',      label: 'Apartment type',       col: 'apt_type_mkmn4bgg' },
  { key: 'device',       label: 'Device',               col: 'text_mm4n6987' },
  { key: 'source',       label: 'Lead source',          col: 'color_mkxk8y67' },
  { key: 'channel',      label: 'Lead channel',         col: 'dropdown_mkxkfbff' },
  { key: 'firstChannel', label: 'First channel',        col: 'text_mm4nkhk0' },
  { key: 'campaign',     label: 'Campaign (last)',      col: 'text_mm1c3b5w' },
  { key: 'firstCampaign',label: 'Campaign (first)',     col: 'text_mm4ntp4n' },
  { key: 'term',         label: 'Search term',          col: 'text3__1' },
  { key: 'landing',      label: 'Landing page',         col: 'text_mm1jhhe7' }
];

// ── Public entry ───────────────────────────────────────────────
async function bookerProfileSections (days) {
  const untilMs  = Date.now();
  const sinceMs  = untilMs - days * 86400000;
  const sinceIso = new Date(sinceMs).toISOString().slice(0, 10);

  const [bookings, leads] = await Promise.all([fetchBookings(sinceIso), fetchLeads(sinceMs)]);
  const out = buildProfile({ bookings, leads, days });
  return [todoSection(out, days), profileSection(out, days)];
}

// ── Analysis ───────────────────────────────────────────────────
function buildProfile ({ bookings, leads, days }) {
  const bookers = bookings.filter(b => b.lead);
  const leadCount = leads.length;
  const bookerCount = bookers.length;

  const dims = DIMENSIONS.map(d => {
    const bCounts = tally(bookers.map(b => b.lead[d.col]));
    const lCounts = tally(leads.map(l => l[d.col]));
    const rows = Object.keys(bCounts).map(v => {
      const b = bCounts[v], l = lCounts[v] || 0;
      const bShare = bookerCount ? b / bookerCount : 0;
      const lShare = leadCount ? l / leadCount : 0;
      return { value: v, bookers: b, leads: l, bShare, lShare,
               lift: lShare > 0 ? bShare / lShare : null,
               rate: l > 0 ? b / l : null };
    }).sort((a, b) => b.bookers - a.bookers || (b.lift || 0) - (a.lift || 0));

    // Big lead buckets that never book are the other half of the story.
    const dead = Object.keys(lCounts)
      .filter(v => !bCounts[v] && leadCount && lCounts[v] / leadCount >= 0.10)
      .map(v => ({ value: v, leads: lCounts[v], lShare: lCounts[v] / leadCount }))
      .sort((a, b) => b.leads - a.leads);

    return { ...d, rows, dead };
  });

  const values = bookers.map(b => b.value).filter(v => Number.isFinite(v) && v > 0);
  const daysToBook = bookers.map(b => b.daysToBook).filter(v => Number.isFinite(v));
  const nights = bookers.map(b => b.nights).filter(v => Number.isFinite(v) && v > 0);

  return {
    days, leadCount, bookerCount,
    unlinked: bookings.length - bookerCount,
    rate: leadCount ? bookerCount / leadCount : 0,
    medianValue: median(values), medianDaysToBook: median(daysToBook), medianNights: median(nights),
    dims,
    todos: buildTodos(dims, bookerCount, leadCount)
  };
}

function tally (values) {
  const out = {};
  for (const raw of values) {
    const v = normalise(raw);
    if (!v) continue;
    out[v] = (out[v] || 0) + 1;
  }
  return out;
}
function normalise (v) {
  const s = (v == null ? '' : String(v)).trim();
  if (!s || /^(unknown|n\/a|none|other \(not specified\))$/i.test(s)) return '';
  return s;
}
function median (arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Concrete actions. Each rule needs at least two bookers behind it, so a
// single booking never rewrites the account.
function buildTodos (dims, bookerCount, leadCount) {
  const todos = [];
  const dim = k => dims.find(d => d.key === k);
  const x = n => (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
  const pct = n => Math.round(n * 100) + '%';

  for (const key of ['country', 'nationality']) {
    const d = dim(key);
    d.rows.filter(r => r.bookers >= 2 && r.lift != null && r.lift >= 1.3).slice(0, 3).forEach(r => {
      todos.push({ area: 'Geo', text: `Bid up ${r.value} as a location target on the booking campaigns. ${r.bookers} of ${bookerCount} bookings, ${x(r.lift)}x the lead rate (${d.label.toLowerCase()}).` });
    });
    d.dead.slice(0, 2).forEach(r => {
      todos.push({ area: 'Geo', text: `Bid down or exclude ${r.value}: ${r.leads} leads (${pct(r.lShare)} of all leads), no bookings (${d.label.toLowerCase()}).` });
    });
  }

  dim('term').rows.filter(r => r.bookers >= 1).slice(0, 4).forEach(r => {
    todos.push({ area: 'Search', text: `Add "${r.value}" as a search theme on the Perf Max booking asset group and make sure it is an exact match keyword on Search. ${r.bookers} booking${r.bookers === 1 ? '' : 's'} came from it.` });
  });

  dim('landing').rows.filter(r => r.bookers >= 2 && r.lift != null && r.lift >= 1.3).slice(0, 3).forEach(r => {
    todos.push({ area: 'Landing', text: `Point Perf Max final URLs at ${r.value}. ${r.bookers} bookings landed there${r.lift != null ? `, ${x(r.lift)}x the lead rate` : ''}.` });
  });

  dim('university').rows.filter(r => r.bookers >= 2 && (r.lift == null || r.lift >= 1.3)).slice(0, 3).forEach(r => {
    todos.push({ area: 'University', text: `Give ${r.value} its own asset group and confirm the university page is live. ${r.bookers} bookings.` });
  });

  dim('budget').dead.slice(0, 2).forEach(r => {
    todos.push({ area: 'Budget', text: `Budget band ${r.value} is ${pct(r.lShare)} of leads and has never booked. Add cheap and budget query negatives, or qualify it harder on the form.` });
  });

  dim('campaign').rows.filter(r => r.bookers >= 2 && r.lShare < 0.9).slice(0, 2).forEach(r => {
    todos.push({ area: 'Budget split', text: `${r.value} carries ${r.bookers} of ${bookerCount} bookings. Move budget to it from campaigns with no bookings in the window.` });
  });

  const fc = dim('firstChannel').rows.find(r => /seo|organic|direct/i.test(r.value) && r.bookers >= 2);
  if (fc) todos.push({ area: 'Attribution', text: `${fc.bookers} bookings first arrived via ${fc.value} before the paid click. Keep brand and organic strong; Perf Max is often closing, not opening.` });

  return todos.slice(0, 10);
}

// ── Sections ───────────────────────────────────────────────────
function todoSection (out, days) {
  if (!out.bookerCount) {
    return { title: 'Booker profile: to do', stat: 'no bookings in window', tone: 'plain', empty: true, items: [] };
  }
  return renderTodoCard(out.todos, {
    subtitle: `Built from ${out.bookerCount} booking${out.bookerCount === 1 ? '' : 's'} against ${out.leadCount.toLocaleString('en-GB')} leads, last ${days} days. Each item needs at least two bookings behind it, except search terms.`
  });
}

// Renders a numbered to-do card from { area, text, manual?, id? } items.
// Also used by pmax-review to merge standing manual jobs in front of the
// profile-derived ones. The items are kept on the section so a caller can
// re-render with more of them.
function renderTodoCard (items, { subtitle } = {}) {
  const rows = items.map((t, i) => `
    <tr>
      ${td(`<span style="display:inline-block;min-width:18px;height:18px;line-height:18px;border-radius:9px;background:${t.manual ? BRAND.gold : BRAND.navy};color:#fff;font-size:10.5px;text-align:center;font-weight:600;">${i + 1}</span>`, 'center', 'width:30px;vertical-align:top;')}
      ${td(`<span style="font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.gold};font-weight:600;">${esc(t.area)}</span>${t.manual ? `<span style="font-size:10px;color:${BRAND.muted};"> &middot; standing job${t.id ? ', id ' + esc(t.id) : ''}</span>` : ''}<br>${esc(t.text)}`, 'left', 'line-height:1.5;')}
    </tr>`).join('');
  return {
    title: 'To do',
    stat: `${items.length} action${items.length === 1 ? '' : 's'}`,
    tone: items.length ? 'warn' : 'good',
    subtitle: subtitle || '',
    items,
    html: table('', rows || emptyRow(2, 'Bookers look like the average lead this window. Nothing to change.'))
  };
}

function profileSection (out, days) {
  const gbp = n => '£' + Math.round(n).toLocaleString('en-GB');
  const pct = n => Math.round(n * 100) + '%';
  const x = n => n == null ? '&mdash;' : (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '') + 'x';

  if (!out.bookerCount) {
    return { title: 'Booker profile', stat: 'no bookings in window', tone: 'plain', empty: true };
  }

  const headline = `
    <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 14px;">
      <tr>
        ${stat('Bookings', String(out.bookerCount))}
        ${stat('Leads', out.leadCount.toLocaleString('en-GB'))}
        ${stat('Lead to booking', (out.rate * 100).toFixed(1) + '%')}
        ${stat('Median value', out.medianValue != null ? gbp(out.medianValue) : '&mdash;')}
        ${stat('Median days to book', out.medianDaysToBook != null ? String(Math.round(out.medianDaysToBook)) : '&mdash;')}
        ${stat('Median nights', out.medianNights != null ? String(Math.round(out.medianNights)) : '&mdash;')}
      </tr>
    </table>`;

  // A value that covers nearly every lead and every booker says nothing
  // about bookers, so it is left off the table.
  const informative = r => !(r.lShare >= 0.9 && r.lift != null && r.lift >= 0.8 && r.lift <= 1.25);
  const rows = out.dims.map(d => {
    const top = d.rows.filter(informative).slice(0, 4);
    if (!top.length) return '';
    return top.map((r, i) => `<tr>
      ${td(i === 0 ? `<span style="font-weight:600;">${esc(d.label)}</span>` : '', 'left', i === 0 ? '' : 'border-top:0;')}
      ${td(esc(truncate(r.value, 42)))}
      ${td(String(r.bookers), 'right', `font-weight:600;color:${BRAND.green};`)}
      ${td(pct(r.bShare), 'right')}
      ${td(pct(r.lShare), 'right', `color:${BRAND.muted};`)}
      ${td(x(r.lift), 'right', r.lift != null && r.lift >= 1.3 ? `color:${BRAND.green};font-weight:600;` : (r.lift != null && r.lift < 0.7 ? `color:${BRAND.red};` : ''))}
    </tr>`).join('');
  }).join('');

  const deadRows = out.dims.flatMap(d => d.dead.slice(0, 2).map(r => `<tr>
      ${td(esc(d.label))}
      ${td(esc(truncate(r.value, 42)))}
      ${td(String(r.leads), 'right', `color:${BRAND.red};font-weight:600;`)}
      ${td(pct(r.lShare), 'right')}
    </tr>`)).join('');

  return {
    title: 'Booker profile',
    stat: `${out.bookerCount} booking${out.bookerCount === 1 ? '' : 's'}, ${(out.rate * 100).toFixed(1)}% of leads`,
    tone: 'plain',
    subtitle: `Last ${days} days. Share of bookers against share of all leads; lift above 1.3x is where bookers over-index.${out.unlinked ? ` ${out.unlinked} booking${out.unlinked === 1 ? '' : 's'} had no linked lead and are left out.` : ''}`,
    html: headline
      + `<p style="margin:0 0 8px;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.gold};">Where bookers over-index</p>`
      + table(th('Dimension') + th('Value') + th('Bookings', 'right') + th('Of bookers', 'right') + th('Of leads', 'right') + th('Lift', 'right'), rows || emptyRow(6, 'No profile fields populated on the booked leads.'))
      + `<p style="margin:18px 0 8px;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${deadRows ? BRAND.red : BRAND.gold};">Big lead buckets with no bookings</p>`
      + table(th('Dimension') + th('Value') + th('Leads', 'right') + th('Of leads', 'right'), deadRows || emptyRow(4, 'No bucket over 10% of leads is booking-free.'))
  };
}

function stat (label, value) {
  return `<td style="padding:0 8px 0 0;vertical-align:top;">
    <div style="font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.muted};">${esc(label)}</div>
    <div style="font-family:'Baskerville Display PT',Baskerville,Georgia,serif;font-size:20px;color:${BRAND.ink};margin-top:2px;">${value}</div>
  </td>`;
}
function truncate (s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ── Monday ─────────────────────────────────────────────────────
async function mondayQuery (query, attempt = 0) {
  try {
    const r = await fetch(MONDAY_API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY }, body: JSON.stringify({ query }) });
    const d = await r.json();
    if (d.errors) throw new Error(JSON.stringify(d.errors).slice(0, 200));
    return d;
  } catch (e) {
    if (attempt >= 2) throw e;
    await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    return mondayQuery(query, attempt + 1);
  }
}

const COLS_JSON = JSON.stringify(LEAD_COLS);

// Bookings closed in the window with their linked lead's profile columns.
// Cancelled or fallen-through rows are left out; the profile is of people
// who actually stayed.
async function fetchBookings (sinceIso) {
  const frag = `id name created_at column_values(ids: ["formula2","numeric_mm1ge9h4","date9","status"]) { id text ... on FormulaValue { display_value } ... on MirrorValue { display_value } }
    relation: column_values(ids: ["link_to_leads26"]) { ... on BoardRelationValue { linked_items { id created_at column_values(ids: ${COLS_JSON}) { id text } } } }`;
  const items = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const q = cursor
      ? `query { next_items_page(limit: 200, cursor: ${JSON.stringify(cursor)}) { cursor items { ${frag} } } }`
      : `query { boards(ids: ${BOOKINGS_BOARD}) { items_page(limit: 200, query_params: {
           rules: [{ column_id: "date9", compare_value: ["${sinceIso}"], operator: greater_than_or_equals }] }) {
           cursor items { ${frag} } } } }`;
    const d  = await mondayQuery(q);
    const pg = cursor ? d?.data?.next_items_page : d?.data?.boards?.[0]?.items_page;
    if (!pg) break;
    items.push(...(pg.items || []));
    cursor = pg.cursor;
    if (!cursor) break;
  }

  return items.map(it => {
    const cv = {}; it.column_values.forEach(c => { cv[c.id] = c.display_value || c.text || ''; });
    if (/cancel|lost|fell|withdrawn/i.test(cv.status || '')) return null;
    const leadItem = it.relation?.[0]?.linked_items?.[0];
    let lead = null;
    if (leadItem) {
      lead = {};
      (leadItem.column_values || []).forEach(c => { lead[c.id] = (c.text || '').trim(); });
    }
    const value = bookingValue(cv).value;
    const closeMs = Date.parse(cv.date9 || '') || Date.parse(it.created_at || '') || NaN;
    const leadMs  = leadItem ? Date.parse(leadItem.created_at || '') : NaN;
    const inMs  = lead ? Date.parse(lead.date47 || '') : NaN;
    const outMs = lead ? Date.parse(lead.date_1 || '') : NaN;
    return {
      id: it.id,
      value: Number.isFinite(value) ? value : null,
      daysToBook: Number.isFinite(closeMs) && Number.isFinite(leadMs) ? (closeMs - leadMs) / 86400000 : null,
      nights: Number.isFinite(inMs) && Number.isFinite(outMs) ? Math.round((outMs - inMs) / 86400000) : null,
      lead
    };
  }).filter(Boolean);
}

// Every lead created in the window, newest first, stopping at the floor.
// Capped at 40 pages (4,000 leads) so a wide window cannot run away.
async function fetchLeads (sinceMs) {
  const leads = [];
  let cursor = null;
  for (let page = 0; page < 40; page++) {
    const q = cursor
      ? `query { next_items_page(limit: 100, cursor: ${JSON.stringify(cursor)}) { cursor items { id created_at column_values(ids: ${COLS_JSON}) { id text } } } }`
      : `query { boards(ids: ${LEADS_BOARD}) { items_page(limit: 100, query_params: {
           order_by: [{ column_id: "__creation_log__", direction: desc }]
         }) { cursor items { id created_at column_values(ids: ${COLS_JSON}) { id text } } } } }`;
    const d  = await mondayQuery(q);
    const pg = cursor ? d?.data?.next_items_page : d?.data?.boards?.[0]?.items_page;
    if (!pg) break;
    let hitFloor = false;
    for (const it of (pg.items || [])) {
      if (new Date(it.created_at || 0).getTime() < sinceMs) { hitFloor = true; break; }
      const c = { id: it.id, createdAt: it.created_at };
      it.column_values.forEach(x => { c[x.id] = (x.text || '').trim(); });
      leads.push(c);
    }
    cursor = pg.cursor;
    if (hitFloor || !cursor) break;
  }
  return leads;
}

module.exports = { bookerProfileSections, buildProfile, todoSection, profileSection, renderTodoCard, DIMENSIONS };
