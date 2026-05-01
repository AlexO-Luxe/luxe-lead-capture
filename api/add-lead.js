// ============================================================
//  Student Luxe — Add Lead endpoint
//  Deploy to: /api/add-lead.js in your Vercel project
//
//  Called when team clicks "Add to Leads Board" in a duplicate
//  alert email. Verifies the HMAC signature, creates the Monday
//  item, then shows a simple confirmation page.
//
//  Environment variables required:
//    MONDAY_API_KEY
//    MONDAY_ADD_LEAD_SECRET   (same value as in submit-enquiry.js)
// ============================================================

const MONDAY_API   = 'https://api.monday.com/v2';
const MONDAY_BOARD = 2171015719;
const crypto       = require('crypto');

module.exports = async function handler(req, res) {

  const { payload, sig } = req.query;

  if (!payload || !sig) {
    return res.status(400).send(page('Missing parameters', 'Invalid link — payload or signature missing.', false));
  }

  // Verify HMAC signature
  const secret   = process.env.MONDAY_ADD_LEAD_SECRET || 'changeme';
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (sig !== expected) {
    return res.status(403).send(page('Invalid link', 'This link is invalid or has been tampered with.', false));
  }

  // Decode payload
  let p, submitterIp;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    p            = decoded.p;
    submitterIp  = decoded.ip || '';
  } catch(e) {
    return res.status(400).send(page('Invalid payload', 'Could not decode the lead data.', false));
  }

  // Check if already added (query Monday for this email)
  try {
    const existing = await findByEmail(p.email);
    // If more than one result exists, it was likely already added via this button
    if (existing.length > 1) {
      return res.status(200).send(page(
        'Already added',
        `A lead for <strong>${escHtml(p.full_name || p.email)}</strong> already exists on the Leads Board — it may have been added already.`,
        false,
        `https://studentluxe.monday.com/boards/${MONDAY_BOARD}`
      ));
    }
  } catch(e) {
    console.warn('Pre-check query failed (non-fatal):', e.message);
  }

  // Push to Monday
  try {
    const mondayId = await pushToMonday(p, submitterIp);
    const crmUrl   = `https://studentluxe.monday.com/boards/${MONDAY_BOARD}/pulses/${mondayId}`;
    return res.status(200).send(page(
      'Lead added',
      `<strong>${escHtml(p.full_name || p.email)}</strong> has been added to the Leads Board successfully.`,
      true,
      crmUrl
    ));
  } catch(err) {
    console.error('add-lead Monday push failed:', err.message);
    return res.status(500).send(page(
      'Something went wrong',
      `Failed to add lead to Monday: ${escHtml(err.message)}`,
      false
    ));
  }
};

// ── Confirmation page ─────────────────────────────────────────
function page(title, message, success, crmUrl) {
  const icon   = success ? '✓' : '✕';
  const colour = success ? '#B8966E' : '#c0392b';
  const btnHtml = crmUrl
    ? `<a href="${crmUrl}" style="display:inline-block;margin-top:20px;padding:12px 28px;background:#B8966E;color:#fff;border-radius:8px;font-size:13px;font-weight:500;text-decoration:none;font-family:'DM Sans',Helvetica,Arial,sans-serif;">View on Leads Board →</a>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Student Luxe</title></head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
<div style="max-width:480px;width:100%;margin:32px auto;background:#fff;border-radius:16px;border:0.5px solid rgba(184,150,110,0.3);overflow:hidden;">
  <div style="background:#B8966E;padding:24px 32px;display:flex;align-items:center;justify-content:space-between;">
    <span style="font-family:Georgia,serif;font-size:20px;font-weight:400;color:#fff;letter-spacing:-0.02em;">Student Luxe</span>
    <div style="width:44px;height:44px;border-radius:50%;border:1.5px solid rgba(255,255,255,0.6);display:flex;align-items:center;justify-content:center;">
      <span style="font-family:Georgia,serif;font-style:italic;font-size:13px;color:rgba(255,255,255,0.9);">luxe</span>
    </div>
  </div>
  <div style="padding:32px;">
    <div style="width:48px;height:48px;border-radius:50%;border:1.5px solid ${colour};display:flex;align-items:center;justify-content:center;margin:0 0 20px;font-size:20px;color:${colour};">${icon}</div>
    <h1 style="font-family:Georgia,serif;font-size:22px;font-weight:400;color:#1a1a1a;margin:0 0 10px;letter-spacing:-0.02em;">${title}</h1>
    <p style="font-size:14px;color:#6b6b6b;line-height:1.7;margin:0;">${message}</p>
    ${btnHtml}
  </div>
</div>
</body></html>`;
}

// ── Monday helpers (duplicated from submit-enquiry for standalone deploy) ──
async function findByEmail(email) {
  if (!email) return [];
  const query = `
    query {
      items_page_by_column_values(
        board_id: ${MONDAY_BOARD}, limit: 10,
        columns: [{ column_id: "email", column_values: ["${email.toLowerCase().trim()}"] }]
      ) { items { id name } }
    }
  `;
  const res  = await fetch(MONDAY_API, { method:'POST', headers:{'Content-Type':'application/json','Authorization':process.env.MONDAY_API_KEY}, body: JSON.stringify({ query }) });
  const data = await res.json();
  return data?.data?.items_page_by_column_values?.items || [];
}

function currencyForCity(city) {
  const GBP = ['london','edinburgh','glasgow','manchester','cambridge','durham','bristol','birmingham','brighton','liverpool','nottingham'];
  const EUR = ['dublin','paris','milan','amsterdam','rome','florence','helsinki','barcelona','madrid','lisbon','porto','valencia'];
  const USD = ['new-york','boston','chicago','washington','philadelphia'];
  const c   = (city || '').toLowerCase().trim();
  if (GBP.includes(c)) return '£';
  if (EUR.includes(c)) return '€';
  if (USD.includes(c)) return '$';
  return '';
}

async function pushToMonday(p, submitterIp) {
  const nameParts  = (p.full_name || '').trim().split(' ');
  const columnValues = {
    text37:           nameParts[0] || '',
    text60:           nameParts.slice(1).join(' ') || '',
    email:            p.email ? { email: p.email, text: p.email } : {},
    phone_1:          p.phone ? { phone: p.phone.replace(/[\s\-().]/g,''), countryShortName:'GB' } : {},
    date47:           p.check_in  ? { date: p.check_in  } : {},
    date_1:           p.check_out ? { date: p.check_out } : {},
    budget_per_week:  p.budget || '',
    text8:            p.city === 'other' ? (p.other_city || '') : (p.city || ''),
    dropdown6:        p.apartment_ref || '',
    apt_type_mkmn4bgg: p.apartment_type || '',
    text9__1:         p.nationality || '',
    long_text7:       p.message || '',
    text_mm1d87rp:    submitterIp || '',
    text_mm1jhhe7:    p.landing_page || '',
    long_text__1:     p.visited_paths || '',
    dropdown_mm1v31yb: { labels: ['/Reservations Form'] },
    ...(currencyForCity(p.city) && { status0__1: { label: currencyForCity(p.city) } }),
  };

  const mutation = `
    mutation {
      create_item(
        board_id: ${MONDAY_BOARD},
        item_name: ${JSON.stringify(p.full_name || 'New Enquiry')},
        column_values: ${JSON.stringify(JSON.stringify(columnValues))}
      ) { id }
    }
  `;

  const res  = await fetch(MONDAY_API, { method:'POST', headers:{'Content-Type':'application/json','Authorization':process.env.MONDAY_API_KEY}, body: JSON.stringify({ query: mutation }) });
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data?.data?.create_item?.id;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
