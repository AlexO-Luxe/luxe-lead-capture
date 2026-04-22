// ============================================================
//  Student Luxe — Weekly Conversion Summary
//  Deploy to: /api/weekly-summary.js
//
//  Runs every Friday at 9:00am UTC via Vercel cron.
//  Pulls conversion data from Monday.com boards.
//  Sends a summary email to alex@studentluxe.co.uk via Resend.
//
//  Add to vercel.json:
//  {
//    "crons": [{ "path": "/api/weekly-summary", "schedule": "0 9 * * 5" }]
//  }
//
//  Environment variables required:
//    MONDAY_API_KEY
//    RESEND_API_KEY
// ============================================================

const MONDAY_API    = 'https://api.monday.com/v2';
const RESEND_API    = 'https://api.resend.com/emails';
const LEADS_BOARD   = 2171015719;
const BOOKING_BOARD = 2171015589;

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const now        = new Date();
    const lastFriday = getLastFriday9am(now);

    console.log(`Weekly summary: ${lastFriday.toISOString()} → ${now.toISOString()}`);

    const [leadsData, bookingData] = await Promise.all([
      fetchLeadsData(lastFriday),
      fetchBookingData(lastFriday)
    ]);

    const summary = {
      step1:      leadsData.step1,
      step2:      leadsData.step2,
      step3:      leadsData.step3,
      step4:      bookingData.items,
      step4Total: bookingData.total
    };

    console.log('Summary:', JSON.stringify({
      step1: summary.step1, step2: summary.step2,
      step3: summary.step3, step4Count: summary.step4.length,
      step4Total: summary.step4Total
    }));

    await sendSummaryEmail({ summary, dateFrom: lastFriday, dateTo: now });

    return res.status(200).json({ success: true, summary: {
      step1: summary.step1, step2: summary.step2,
      step3: summary.step3, step4Count: summary.step4.length,
      step4Total: summary.step4Total
    }});

  } catch (err) {
    console.error('Weekly summary error:', err.message);
    return res.status(200).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────────────────────
//  FETCH LEADS DATA FROM MONDAY LEADS BOARD
// ──────────────────────────────────────────────────────────────
async function fetchLeadsData(since) {
  let allItems = [];
  let cursor   = null;
  let page     = 1;

  do {
    const pageArg = cursor ? `, cursor: "${cursor}"` : '';
    const query   = `
      query {
        boards(ids: [${LEADS_BOARD}]) {
          items_page(limit: 500${pageArg}) {
            cursor
            items {
              id
              created_at
              column_values(ids: ["text4__1", "color_mkt29g1r", "color_mkxk8y67"]) {
                id
                text
              }
            }
          }
        }
      }
    `;

    const result    = await mondayQuery(query);
    const page_data = result?.data?.boards?.[0]?.items_page;
    const items     = page_data?.items || [];
    allItems        = allItems.concat(items);
    cursor          = page_data?.cursor || null;
    page++;

    if (items.every(i => new Date(i.created_at) < since)) break;
    if (items.length < 500) break;

  } while (cursor && page <= 10);

  const recent = allItems.filter(i => new Date(i.created_at) >= since);

  let step1 = 0, step2 = 0, step3 = 0;

  recent.forEach(item => {
    const cols = {};
    item.column_values.forEach(c => { cols[c.id] = (c.text || '').trim(); });

    const gclid     = cols['text4__1'];
    const potential = (cols['color_mkt29g1r'] || '').toLowerCase();
    const source    = (cols['color_mkxk8y67'] || '').toLowerCase();

    if (gclid && source.includes('ppc')) step1++;
    if (potential.includes('moderate'))   step2++;
    if (potential.includes('high'))       step3++;
  });

  return { step1, step2, step3 };
}

// ──────────────────────────────────────────────────────────────
//  FETCH BOOKING DATA FROM MONDAY BOOKING FLOW BOARD
// ──────────────────────────────────────────────────────────────
async function fetchBookingData(since) {
  let allItems = [];
  let cursor   = null;
  let page     = 1;

  do {
    const pageArg = cursor ? `, cursor: "${cursor}"` : '';
    const query   = `
      query {
        boards(ids: [${BOOKING_BOARD}]) {
          items_page(limit: 500${pageArg}) {
            cursor
            items {
              id
              name
              updated_at
              column_values(ids: ["numeric_mm1ge9h4", "status"]) {
                id
                text
              }
            }
          }
        }
      }
    `;

    const result    = await mondayQuery(query);
    const page_data = result?.data?.boards?.[0]?.items_page;
    const items     = page_data?.items || [];
    allItems        = allItems.concat(items);
    cursor          = page_data?.cursor || null;
    page++;

    if (items.length < 500) break;

  } while (cursor && page <= 5);

  const items = allItems
    .filter(item => {
      const cols    = {};
      item.column_values.forEach(c => { cols[c.id] = (c.text || '').trim(); });
      const revenue = parseFloat(cols['numeric_mm1ge9h4'] || 0);
      const updated = new Date(item.updated_at);
      return revenue > 0 && updated >= since;
    })
    .map(item => {
      const cols = {};
      item.column_values.forEach(c => { cols[c.id] = (c.text || '').trim(); });
      return {
        name:   item.name,
        value:  parseFloat(cols['numeric_mm1ge9h4'] || 0),
        status: cols['status'] || '—'
      };
    })
    .sort((a, b) => b.value - a.value);

  const total = items.reduce((s, i) => s + i.value, 0);
  return { items, total };
}

// ──────────────────────────────────────────────────────────────
//  MONDAY QUERY HELPER
// ──────────────────────────────────────────────────────────────
async function mondayQuery(query) {
  const res = await fetch(MONDAY_API, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': process.env.MONDAY_API_KEY
    },
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
  const d          = new Date(now);
  const dayOfWeek  = d.getUTCDay();
  const daysSince  = dayOfWeek >= 5 ? dayOfWeek - 5 : dayOfWeek + 2;
  d.setUTCDate(d.getUTCDate() - (daysSince === 0 ? 7 : daysSince));
  d.setUTCHours(9, 1, 0, 0);
  return d;
}

function formatDisplayDate(date) {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London'
  });
}

function formatDisplayDateTime(date) {
  return date.toLocaleString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'Europe/London'
  }).replace(', ', ' at ');
}

// ──────────────────────────────────────────────────────────────
//  SEND SUMMARY EMAIL
// ──────────────────────────────────────────────────────────────
async function sendSummaryEmail({ summary, dateFrom, dateTo }) {

  const periodLabel      = `${formatDisplayDate(dateFrom)} – ${formatDisplayDate(dateTo)}`;
  const totalConversions = summary.step1 + summary.step2 + summary.step3 + summary.step4.length;

  const steps = [
    { step: 1, label: 'Server-side enquiry form', count: summary.step1,        value: '£1 fixed',   color: '#4A90D9' },
    { step: 2, label: 'Moderate potential leads',  count: summary.step2,        value: '£150 fixed', color: '#F5A623' },
    { step: 3, label: 'High potential leads',      count: summary.step3,        value: '£300 fixed', color: '#E8703A' },
    { step: 4, label: 'Confirmed bookings',        count: summary.step4.length, value: 'variable',   color: '#417505' }
  ];

  const stepRows = steps.map(r => `
    <tr>
      <td style="padding:12px 16px;border-bottom:0.5px solid #ede9e3;vertical-align:middle;">
        <span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:${r.color};color:#fff;font-size:10px;font-weight:600;text-align:center;line-height:22px;margin-right:10px;vertical-align:middle;">${r.step}</span>
        <span style="font-size:13px;color:#1a1a1a;font-weight:500;vertical-align:middle;">${r.label}</span>
      </td>
      <td style="padding:12px 16px;border-bottom:0.5px solid #ede9e3;text-align:center;">
        <span style="font-size:22px;font-weight:700;color:${r.count > 0 ? r.color : '#9b9b9b'};">${r.count}</span>
      </td>
      <td style="padding:12px 16px;border-bottom:0.5px solid #ede9e3;text-align:right;font-size:12px;color:#6b6b6b;">
        ${r.step === 4 && summary.step4Total > 0
          ? `<strong style="color:#1a1a1a;">£${summary.step4Total.toLocaleString('en-GB', {minimumFractionDigits:2,maximumFractionDigits:2})}</strong>`
          : r.value}
      </td>
    </tr>`).join('');

  const bookingRows = summary.step4.length > 0
    ? summary.step4.map(b => `
    <tr>
      <td style="padding:8px 16px;border-bottom:0.5px solid #f0ece3;font-size:12px;color:#1a1a1a;">${escHtml(b.name)}</td>
      <td style="padding:8px 16px;border-bottom:0.5px solid #f0ece3;font-size:12px;color:#6b6b6b;text-align:center;">${escHtml(b.status)}</td>
      <td style="padding:8px 16px;border-bottom:0.5px solid #f0ece3;font-size:13px;color:#417505;font-weight:600;text-align:right;">£${b.value.toLocaleString('en-GB', {minimumFractionDigits:2,maximumFractionDigits:2})}</td>
    </tr>`).join('')
    : `<tr><td colspan="3" style="padding:16px;text-align:center;font-size:12px;color:#9b9b9b;font-style:italic;">No confirmed bookings with revenue submitted this week</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Weekly Conversion Summary</title></head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.3);">
  <tr><td style="background:#0d1a2e;padding:28px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>
        <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.45);">Weekly Report</p>
        <h1 style="margin:0;font-family:Georgia,serif;font-size:24px;font-weight:400;color:#f0ece2;line-height:1.2;letter-spacing:-0.02em;">Conversion Summary</h1>
        <p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,0.5);">${periodLabel}</p>
      </td>
      <td style="text-align:right;vertical-align:top;">
        <img src="https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/4d6b8086-53ed-4d17-b8f7-20f67be76f41/luxe-white.png?content-type=image%2Fpng" alt="Student Luxe" style="height:36px;width:auto;">
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#ffffff;padding:24px 32px 0;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="50%" style="padding-right:8px;">
        <div style="background:#f7f2eb;border-radius:10px;padding:16px;text-align:center;">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#B8966E;">Total conversions</p>
          <p style="margin:0;font-family:Georgia,serif;font-size:36px;font-weight:400;color:#0d1a2e;letter-spacing:-0.03em;">${totalConversions}</p>
        </div>
      </td>
      <td width="50%" style="padding-left:8px;">
        <div style="background:#f7f2eb;border-radius:10px;padding:16px;text-align:center;">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#B8966E;">Booking revenue</p>
          <p style="margin:0;font-family:Georgia,serif;font-size:36px;font-weight:400;color:#417505;letter-spacing:-0.03em;">£${summary.step4Total.toLocaleString('en-GB', {minimumFractionDigits:0,maximumFractionDigits:0})}</p>
        </div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#ffffff;padding:20px 32px 0;">
    <p style="margin:0 0 12px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Conversion funnel</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:0.5px solid #ede9e3;border-radius:10px;overflow:hidden;">
      <thead><tr style="background:#f7f2eb;">
        <th style="padding:10px 16px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9b9b9b;font-weight:500;text-align:left;">Step</th>
        <th style="padding:10px 16px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9b9b9b;font-weight:500;text-align:center;">Count</th>
        <th style="padding:10px 16px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9b9b9b;font-weight:500;text-align:right;">Value</th>
      </tr></thead>
      <tbody>${stepRows}</tbody>
    </table>
  </td></tr>
  <tr><td style="background:#ffffff;padding:20px 32px 28px;">
    <p style="margin:0 0 12px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Step 4 — Confirmed bookings breakdown</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:0.5px solid #ede9e3;border-radius:10px;overflow:hidden;">
      <thead><tr style="background:#f7f2eb;">
        <th style="padding:10px 16px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9b9b9b;font-weight:500;text-align:left;">Booking</th>
        <th style="padding:10px 16px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9b9b9b;font-weight:500;text-align:center;">Status</th>
        <th style="padding:10px 16px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9b9b9b;font-weight:500;text-align:right;">Revenue</th>
      </tr></thead>
      <tbody>${bookingRows}</tbody>
      ${summary.step4.length > 0 ? `
      <tfoot><tr style="background:#f7f2eb;">
        <td colspan="2" style="padding:10px 16px;font-size:12px;font-weight:600;color:#1a1a1a;">Total</td>
        <td style="padding:10px 16px;font-size:13px;font-weight:700;color:#417505;text-align:right;">£${summary.step4Total.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
      </tr></tfoot>` : ''}
    </table>
  </td></tr>
  <tr><td style="background:#f7f2eb;padding:16px 32px;border-top:0.5px solid rgba(184,150,110,0.2);text-align:center;">
    <p style="margin:0;font-size:11px;color:#9b9b9b;line-height:1.8;">
      Student Luxe Apartments &nbsp;·&nbsp; Automated weekly report<br>
      Generated ${formatDisplayDateTime(new Date())} &nbsp;·&nbsp; Data source: Monday.com
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const r = await fetch(RESEND_API, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      from:    'Student Luxe <reservations@studentluxe.co.uk>',
      to:      ['alex@studentluxe.co.uk'],
      subject: `📊 Weekly Conversions — ${totalConversions} total${summary.step4Total > 0 ? `, £${summary.step4Total.toLocaleString('en-GB',{minimumFractionDigits:0,maximumFractionDigits:0})} bookings` : ''} (${formatDisplayDate(dateFrom).split(' ').slice(0,2).join(' ')} – ${formatDisplayDate(dateTo).split(' ').slice(0,2).join(' ')})`,
      html
    })
  });

  if (!r.ok) throw new Error(`Resend error ${r.status}: ${await r.text()}`);
  return r.json();
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
