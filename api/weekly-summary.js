// ============================================================
//  Student Luxe — Weekly Conversion Summary
//  Deploy to: /api/weekly-summary.js
//  Runs every Friday at 9:00am UTC via Vercel cron.
// ============================================================

const MONDAY_API    = 'https://api.monday.com/v2';
const RESEND_API    = 'https://api.resend.com/emails';
const BOOKING_BOARD = 2171015589;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const now = new Date();

    // Manual / test trigger: ?days=N&secret=<CRON_SECRET>&dryRun=1
    const isTest    = req.query?.secret === process.env.CRON_SECRET;
    const customDays = isTest ? parseInt(req.query.days || '7', 10) : null;
    const dryRun     = isTest && req.query.dryRun === '1';

    const weekFrom = customDays
      ? new Date(now.getTime() - customDays * 24 * 60 * 60 * 1000)
      : getLastFriday9am(now);

    // If we're in first 3 days of month, show previous month's total
    const dayOfMonth = now.getUTCDate();
    const monthStart = dayOfMonth <= 3
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const monthEnd = dayOfMonth <= 3
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      : now;

    console.log(`Weekly window: ${weekFrom.toISOString()} → ${now.toISOString()}`);
    console.log(`Month  window: ${monthStart.toISOString()} → ${monthEnd.toISOString()}`);

    const [weekData, monthData] = await Promise.all([
      fetchBookingData(weekFrom, now),
      fetchBookingData(monthStart, monthEnd)
    ]);

    if (dryRun) {
      return res.status(200).json({
        dryRun:    true,
        week:      { from: weekFrom.toISOString(), to: now.toISOString(), count: weekData.items.length, total: weekData.total, items: weekData.items },
        month:     { from: monthStart.toISOString(), to: monthEnd.toISOString(), count: monthData.items.length, total: monthData.total, items: monthData.items }
      });
    }

    await sendSummaryEmail({
      weekItems:   weekData.items,
      weekTotal:   weekData.total,
      monthTotal:  monthData.total,
      dateFrom:    weekFrom,
      dateTo:      now,
      monthStart,
      isTest
    });

    return res.status(200).json({ success: true, weekCount: weekData.items.length, weekTotal: weekData.total, monthTotal: monthData.total });

  } catch (err) {
    console.error('Weekly summary error:', err.message);
    return res.status(200).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────────────────────
//  FETCH PPC BOOKINGS WITH REVENUE IN DATE RANGE
// ──────────────────────────────────────────────────────────────
async function fetchBookingData(since, until) {
  let allItems = [], cursor = null;
  const EXCLUDED = ['Pending Bookings', 'Cancelled Bookings', 'Lost Bookings'];

  do {
    const pageArg = cursor ? `, cursor: "${cursor}"` : '';
    // mirror21__1 + lookup_mkxtxk48 are mirror / lookup columns —
    // they only populate via display_value, never via plain text.
    const query = `
      query {
        boards(ids: [${BOOKING_BOARD}]) {
          items_page(limit: 500${pageArg}) {
            cursor
            items {
              id name created_at updated_at
              group { title }
              column_values(ids: ["numeric_mm1ge9h4", "status", "mirror21__1", "lookup_mkxtxk48", "date9"]) {
                id text
                ... on MirrorValue        { display_value }
                ... on BoardRelationValue { display_value }
                ... on StatusValue        { label }
              }
              relation: column_values(ids: ["link_to_leads26"]) {
                id
                ... on BoardRelationValue {
                  linked_items {
                    id
                    column_values(ids: ["text_mm1c3b5w"]) { id text }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const result  = await mondayQuery(query);
    const page    = result?.data?.boards?.[0]?.items_page;
    allItems      = allItems.concat(page?.items || []);
    cursor        = page?.cursor || null;
    if ((page?.items || []).length < 500) break;
  } while (cursor);

  const items = allItems
    .filter(item => {
      if (EXCLUDED.includes(item.group?.title)) return false;
      const cols   = colMap(item);
      const rev    = parseFloat(cols['numeric_mm1ge9h4'] || 0);
      const source = (cols['lookup_mkxtxk48'] || '').toLowerCase();
      const isPPC  = source.includes('ppc');
      if (!rev || !isPPC) return false;
      // Filter by date9: the booking's contractual close / check-in
      // date. This is how Alex accounts revenue — a booking belongs
      // to the month its close date falls in, regardless of when the
      // Monday row was first created or last updated.
      const closeRaw = cols['date9'];
      if (!closeRaw) return false;
      const close = new Date(closeRaw);
      if (isNaN(close)) return false;
      return close >= since && close < until;
    })
    .map(item => {
      const cols = colMap(item);
      // Campaign name lives on the linked lead in column text_mm1c3b5w.
      const linkedLead = item.relation?.[0]?.linked_items?.[0];
      const campaign   = linkedLead?.column_values?.find(c => c.id === 'text_mm1c3b5w')?.text || '';
      return {
        name:      item.name,
        value:     parseFloat(cols['numeric_mm1ge9h4'] || 0),
        status:    cols['status'] || '—',
        source:    cols['lookup_mkxtxk48'] || '',
        campaign,
        group:     item.group?.title || '',
        created:   item.created_at,
        closeDate: cols['date9'] || '',
        gclid:     cols['mirror21__1'] || ''
      };
    })
    .sort((a, b) => b.value - a.value);

  const total = items.reduce((s, i) => s + i.value, 0);
  return { items, total };
}

function colMap(item) {
  const map = {};
  (item.column_values || []).forEach(c => {
    map[c.id] = c.display_value || c.label || c.text || '';
  });
  return map;
}

async function mondayQuery(query) {
  const res = await fetch(MONDAY_API, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
    body: JSON.stringify({ query })
  });
  const data = await res.json();
  if (data.errors) throw new Error('Monday API error: ' + JSON.stringify(data.errors));
  return data;
}

// ──────────────────────────────────────────────────────────────
//  DATE HELPERS
// ──────────────────────────────────────────────────────────────
function getLastFriday9am(now) {
  const d         = new Date(now);
  const dayOfWeek = d.getUTCDay();
  const daysSince = dayOfWeek >= 5 ? dayOfWeek - 5 : dayOfWeek + 2;
  d.setUTCDate(d.getUTCDate() - (daysSince === 0 ? 7 : daysSince));
  d.setUTCHours(9, 1, 0, 0);
  return d;
}

function fmtDate(date) {
  return date.toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric', timeZone:'Europe/London' });
}
function fmtDateTime(date) {
  return date.toLocaleString('en-GB', { day:'numeric', month:'long', year:'numeric', hour:'numeric', minute:'2-digit', hour12:true, timeZone:'Europe/London' }).replace(', ', ' at ');
}
function fmtMonth(date) {
  return date.toLocaleDateString('en-GB', { month:'long', year:'numeric', timeZone:'Europe/London' });
}

// ──────────────────────────────────────────────────────────────
//  SEND EMAIL
// ──────────────────────────────────────────────────────────────
async function sendSummaryEmail({ weekItems, weekTotal, monthTotal, dateFrom, dateTo, monthStart, isTest }) {
  const periodLabel = `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}`;
  const monthLabel  = fmtMonth(monthStart);

  const bookingRows = weekItems.length > 0
    ? weekItems.map(b => `
    <tr>
      <td style="padding:10px 14px;border-bottom:0.5px solid #f0ece3;font-size:13px;color:#1a1a1a;">${escHtml(b.name)}</td>
      <td style="padding:10px 14px;border-bottom:0.5px solid #f0ece3;font-size:12px;color:#6b6b6b;">${escHtml(b.campaign || '—')}</td>
      <td style="padding:10px 14px;border-bottom:0.5px solid #f0ece3;font-size:13px;font-weight:600;color:#417505;text-align:right;white-space:nowrap;">£${b.value.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
    </tr>`).join('')
    : `<tr><td colspan="3" style="padding:16px;text-align:center;font-size:12px;color:#9b9b9b;font-style:italic;">No confirmed PPC bookings with revenue submitted this week</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:32px 16px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;border-radius:16px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.3);">

  <!-- Header -->
  <tr><td style="background:#0d1a2e;padding:24px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>
        <p style="margin:0 0 2px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.4);">Weekly Report</p>
        <h1 style="margin:0;font-family:Georgia,serif;font-size:22px;font-weight:400;color:#f0ece2;letter-spacing:-0.02em;">PPC Booking Summary</h1>
        <p style="margin:4px 0 0;font-size:11px;color:rgba(255,255,255,0.45);">${periodLabel}</p>
      </td>
      <td style="text-align:right;vertical-align:middle;">
        <img src="https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/4d6b8086-53ed-4d17-b8f7-20f67be76f41/luxe-white.png?content-type=image%2Fpng" alt="Student Luxe" style="height:32px;width:auto;">
      </td>
    </tr></table>
  </td></tr>

  <!-- This week's bookings -->
  <tr><td style="background:#ffffff;padding:24px 32px 20px;">
    <p style="margin:0 0 14px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Confirmed PPC Bookings This Week</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:0.5px solid #ede9e3;border-radius:10px;overflow:hidden;">
      <thead><tr style="background:#f7f2eb;">
        <th style="padding:10px 14px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9b9b9b;font-weight:500;text-align:left;">Booking</th>
        <th style="padding:10px 14px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9b9b9b;font-weight:500;text-align:left;">Campaign</th>
        <th style="padding:10px 14px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9b9b9b;font-weight:500;text-align:right;">Revenue</th>
      </tr></thead>
      <tbody>${bookingRows}</tbody>
      ${weekItems.length > 0 ? `
      <tfoot><tr style="background:#f7f2eb;">
        <td colspan="2" style="padding:10px 14px;font-size:12px;font-weight:600;color:#1a1a1a;">This week total</td>
        <td style="padding:10px 14px;font-size:14px;font-weight:700;color:#417505;text-align:right;white-space:nowrap;">£${weekTotal.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
      </tr></tfoot>` : ''}
    </table>
  </td></tr>

  <!-- Month to date -->
  <tr><td style="background:#ffffff;padding:0 32px 28px;">
    <div style="background:#f7f2eb;border-radius:10px;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;">
      <div>
        <p style="margin:0 0 2px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#B8966E;">Total PPC Revenue — ${escHtml(monthLabel)}</p>
        <p style="margin:0;font-size:11px;color:#9b9b9b;">All confirmed PPC bookings with revenue submitted this month</p>
      </div>
      <p style="margin:0;font-family:Georgia,serif;font-size:28px;font-weight:400;color:#417505;letter-spacing:-0.03em;white-space:nowrap;padding-left:20px;">£${monthTotal.toLocaleString('en-GB',{minimumFractionDigits:0,maximumFractionDigits:0})}</p>
    </div>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#f7f2eb;padding:14px 32px;border-top:0.5px solid rgba(184,150,110,0.2);text-align:center;">
    <p style="margin:0;font-size:11px;color:#9b9b9b;line-height:1.8;">
      Student Luxe Apartments &nbsp;·&nbsp; Automated weekly report<br>
      Generated ${fmtDateTime(new Date())} &nbsp;·&nbsp; Data: Monday.com
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  const subjectPrefix = isTest ? '[TEST] ' : '';
  const subject = weekItems.length > 0
    ? `${subjectPrefix}📊 PPC Bookings — ${weekItems.length} this week, £${weekTotal.toLocaleString('en-GB',{minimumFractionDigits:0})} | ${monthLabel}: £${monthTotal.toLocaleString('en-GB',{minimumFractionDigits:0})}`
    : `${subjectPrefix}📊 PPC Bookings — No new bookings this week | ${monthLabel}: £${monthTotal.toLocaleString('en-GB',{minimumFractionDigits:0})}`;

  const r = await fetch(RESEND_API, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    'Student Luxe <reservations@studentluxe.co.uk>',
      to:      ['alex@studentluxe.co.uk'],
      subject,
      html
    })
  });
  if (!r.ok) throw new Error(`Resend error ${r.status}: ${await r.text()}`);
  return r.json();
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
