// ============================================================
//  Student Luxe — Enquiry Submit + Email Handler
//  Deploy to: /api/submit-enquiry.js in your Vercel project
// ============================================================

const RESEND_API   = 'https://api.resend.com/emails';
const MONDAY_API   = 'https://api.monday.com/v2';
const MONDAY_BOARD = 2171015719;

const { buildTouch, getSession, attachSubmission, classifyTouch } = require('./_attribution.js');
const { sendGadsAlert, sendGadsSuccess } = require('./_alert.js');
const { logGadsEvent }  = require('./_log.js');

// ── IP BLOCKLIST ──────────────────────────────────────────────
// Add spammer IPs here. Returns fake success so they don't know they're blocked.
const BLOCKED_IPS = [
  '154.192.222.128',
];

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const p = req.body;

  // ── Get submitter IP ──────────────────────────────────────
  const submitterIp =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    '';

  // ── IP block check ────────────────────────────────────────
  if (BLOCKED_IPS.includes(submitterIp)) {
    console.log('Blocked IP rejected:', submitterIp);
    return res.status(200).json({ success: true }); // silent — spammer sees normal success
  }

  // ── Attribution capture (cookies, headers, body) ──────────
  // Touch = last-click + full session metadata. Session record
  // pulled from KV holds first-click + multi-touch path.
  const touch     = buildTouch(req, p);
  const sessionId = p.session_id || touch.session_id || '';
  const session   = sessionId ? await getSession(sessionId) : null;
  const firstTouch = session?.first || touch;

  // Surface gbraid/wbraid/UA into the body so downstream funcs (Monday
  // push, Google Ads upload) pick them up without changing signatures.
  p.gbraid     = p.gbraid     || touch.gbraid;
  p.wbraid     = p.wbraid     || touch.wbraid;
  p.user_agent = touch.userAgent;
  p.device     = touch.device;
  p.browser    = touch.browser;
  p.os         = touch.os;
  p.country    = touch.country;
  p.city_geo   = touch.city;
  p.region     = touch.region;
  p.session_id = sessionId;

  // Partner portals serve a single campus, so the guest is never asked which
  // city and the portal's own city is authoritative. Set here, before anything
  // downstream reads p.city (Monday city + currency columns, email subjects).
  const portalCfg = partnerPortal(p);
  if (portalCfg?.city) p.city = portalCfg.city;
  p.first_touch = firstTouch;
  p.last_touch  = touch;

  // Fallback: the journey fields (landing_page, visited_paths) are populated
  // client-side from localStorage / cookies. When those are empty (storage
  // blocked, direct landing, or the site tracker did not run on the entry
  // page) the lead arrives with a blank journey. Rebuild from the KV session
  // journal that /api/track recorded server-side, keyed by sl_session_id.
  if (!p.landing_page && firstTouch?.landing) p.landing_page = firstTouch.landing;
  if (!p.visited_paths && session?.touches?.length) {
    p.visited_paths = session.touches
      .map(t => `${t.source || 'Direct'} ${t.path || ''}`.trim())
      .join(' 👉 ');
  }

  // ── Duplicate check — 4 signals (email, phone, IP, name) ─────
  // Flags as possible duplicate when 2 or more signals match.
  let duplicateOf = null;
  try {
    duplicateOf = await findDuplicateLead(p, submitterIp);
  } catch(err) {
    console.warn('Duplicate check failed (non-fatal):', err.message);
  }

  if (duplicateOf) {
    console.log(`Duplicate detected (${duplicateOf.matchCount}/4) — existing lead ID:`, duplicateOf.id);
  }

  // ── Always push to Monday ─────────────────────────────────
  let mondayId    = null;
  let mondayError = null;
  try {
    mondayId = await pushToMonday(p, submitterIp, duplicateOf);
    console.log('Monday OK — pulse ID:', mondayId);
  } catch(err) {
    mondayError = err.message || 'Unknown error';
    console.error('Monday failed:', mondayError);
  }

  // Compute lead source for email
  const { leadSource, leadChannel } = computeLeadSource(p);

  const results = await Promise.allSettled([
    sendGuestConfirmation(p),
    sendTeamNotification(p, mondayId, mondayError, duplicateOf, submitterIp, leadSource, leadChannel)
  ]);

  results.forEach((r, i) => {
    const label = ['Guest email', 'Team email'][i];
    if(r.status === 'rejected') console.error(`${label} failed:`, r.reason?.message || r.reason);
    else console.log(`${label} OK`);
  });

  // ── GOOGLE ADS SERVER-SIDE CONVERSION ─────────────────────
  const gadsCtx = {
    source:    'Student Luxe enquiry',
    action:    'Step 1 NEW (server-side enquiry)',
    email:     p.email,
    mondayId,
    hasGclid:  !!p.gclid,
    hasGbraid: !!p.gbraid,
    hasWbraid: !!p.wbraid
  };
  try {
    const dmResult = await uploadGoogleAdsConversion(p);
    console.log('Google Ads conversion uploaded OK');
    await logGadsEvent({ ...gadsCtx, ok: true });
    await sendGadsSuccess({
      source:  gadsCtx.source,
      action:  gadsCtx.action,
      payload: { email: p.email, name: p.full_name, mondayId, hasGclid: gadsCtx.hasGclid, hasGbraid: gadsCtx.hasGbraid, requestId: dmResult?.requestId }
    });
  } catch(err) {
    console.error('Google Ads conversion failed (non-fatal):', err.message);
    // Log only. Alerting is owned by /api/replay-failed-events, which emails
    // once a fail has not self-healed after STUCK_MS.
    await logGadsEvent({ ...gadsCtx, ok: false, error: err.message });
  }

  // ── Attach submission summary to KV session (non-fatal) ───
  if (sessionId && mondayId) {
    await attachSubmission(sessionId, {
      mondayId,
      brand:      'studentluxe',
      submittedAt: new Date().toISOString(),
      email:      p.email || '',
      name:       p.full_name || ''
    });
  }

  return res.status(200).json({ success: true });
};

// ──────────────────────────────────────────────────────────────
//  DUPLICATE DETECTION — 4 signals (email, phone, IP, name)
//  Each signal scores 0 or 1. A score of 2 or more flags the lead
//  as a possible duplicate. Empty fields never count as a match.
// ──────────────────────────────────────────────────────────────
function normEmail(e)   { return (e  || '').toLowerCase().trim(); }
function normIp(ip)     { return (ip || '').trim(); }
function normName(n)    { return (n  || '').toLowerCase().trim().replace(/\s+/g, ' '); }
function phoneDigits(s) { return (s  || '').replace(/\D/g, ''); }
function phoneTail(s) {
  const d = phoneDigits(s);
  return d.length >= 9 ? d.slice(-9) : d;
}
// Name key = first-initial + surname (lowercased). Loose enough to catch
// "Sarah Jones" vs "S Jones" vs "Sammy Jones" but still discriminating.
function nameKey(n) {
  const cleaned = normName(n);
  if (!cleaned) return null;
  const parts = cleaned.split(' ').filter(Boolean);
  if (!parts.length) return null;
  const surname = parts[parts.length - 1];
  const firstInitial = parts[0][0] || '';
  if (!firstInitial || !surname) return null;
  return `${firstInitial}|${surname}`;
}

// Generic candidate fetcher used by email / phone / IP lookups.
async function mondayLookupByColumn(columnId, value) {
  if (!value) return [];
  const query = `
    query {
      items_page_by_column_values(
        board_id: ${MONDAY_BOARD},
        limit: 25,
        columns: [{ column_id: "${columnId}", column_values: [${JSON.stringify(String(value))}] }]
      ) {
        items {
          id
          name
          created_at
          column_values(ids: ["email", "phone_1", "text_mm2y2ah2", "people_1"]) {
            id text value
          }
        }
      }
    }
  `;
  try {
    const r = await fetch(MONDAY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
      body: JSON.stringify({ query })
    });
    const d = await r.json();
    if (d.errors) {
      console.warn(`Monday lookup (${columnId}) errors:`, JSON.stringify(d.errors));
      return [];
    }
    return d?.data?.items_page_by_column_values?.items || [];
  } catch (err) {
    console.warn(`Monday lookup (${columnId}) failed:`, err.message);
    return [];
  }
}

// Check which Monday user IDs are still active. Used to drop assignments
// to deactivated/removed employees (which would otherwise fail create_item
// with an invalidPersonAssignment error and force a manual lead entry).
// Fail-open on query errors so a flaky users query doesn't cause spurious
// unassignments.
async function verifyMondayUsers(userIds) {
  const idList = (userIds || []).map(Number).filter(n => Number.isFinite(n));
  if (idList.length === 0) return { failed: false, valid: new Set(), nameById: {} };
  const query = `
    query {
      users(ids: [${idList.join(',')}]) {
        id
        name
        enabled
      }
    }
  `;
  try {
    const r = await fetch(MONDAY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
      body: JSON.stringify({ query })
    });
    const d = await r.json();
    if (d.errors) {
      console.warn('Monday user verify errors:', JSON.stringify(d.errors));
      return { failed: true, valid: new Set(idList), nameById: {} };
    }
    const valid = new Set();
    const nameById = {};
    for (const u of (d?.data?.users || [])) {
      nameById[Number(u.id)] = u.name;
      if (u.enabled) valid.add(Number(u.id));
    }
    return { failed: false, valid, nameById };
  } catch (err) {
    console.warn('Monday user verify failed:', err.message);
    return { failed: true, valid: new Set(idList), nameById: {} };
  }
}

// Candidate fetcher for the item-name search (surname contains-text rule).
async function mondayLookupByName(substring) {
  if (!substring) return [];
  // items_page lives inside boards on Monday API v2 — not at root.
  const query = `
    query {
      boards(ids: [${MONDAY_BOARD}]) {
        items_page(
          limit: 50,
          query_params: { rules: [{ column_id: "name", compare_value: [${JSON.stringify(substring)}], operator: contains_text }] }
        ) {
          items {
            id
            name
            created_at
            column_values(ids: ["email", "phone_1", "text_mm2y2ah2", "people_1"]) {
              id text value
            }
          }
        }
      }
    }
  `;
  try {
    const r = await fetch(MONDAY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
      body: JSON.stringify({ query })
    });
    const d = await r.json();
    if (d.errors) {
      console.warn('Monday name lookup errors:', JSON.stringify(d.errors));
      return [];
    }
    return d?.data?.boards?.[0]?.items_page?.items || [];
  } catch (err) {
    console.warn('Monday name lookup failed:', err.message);
    return [];
  }
}

async function findDuplicateLead(p, ip) {
  const newEmail     = normEmail(p.email);
  const newIp        = normIp(ip);
  const newName      = p.full_name || '';
  const newKey       = nameKey(newName);
  const newSurname   = newKey ? newKey.split('|')[1] : '';
  const newPhoneTail = phoneTail(p.phone);
  const newPhoneRaw  = phoneDigits(p.phone);

  // Run all four lookups in parallel. Skip a query when the signal is empty.
  const [emailHits, phoneHits, ipHits, nameHits] = await Promise.all([
    newEmail    ? mondayLookupByColumn('email',         newEmail)    : Promise.resolve([]),
    newPhoneRaw ? mondayLookupByColumn('phone_1',       newPhoneRaw) : Promise.resolve([]),
    newIp       ? mondayLookupByColumn('text_mm2y2ah2', newIp)       : Promise.resolve([]),
    newSurname  ? mondayLookupByName(newSurname)                      : Promise.resolve([]),
  ]);

  // Union candidates by item ID (a single lead may appear in multiple result sets).
  const candidates = new Map();
  for (const item of [...emailHits, ...phoneHits, ...ipHits, ...nameHits]) {
    if (item && item.id && !candidates.has(item.id)) candidates.set(item.id, item);
  }
  if (candidates.size === 0) return null;

  // Score every candidate against the 4 signals. Pick highest score, ties broken by most recent.
  let best = null;
  for (const item of candidates.values()) {
    const ev = item.column_values?.find(c => c.id === 'email');
    const pv = item.column_values?.find(c => c.id === 'phone_1');
    const iv = item.column_values?.find(c => c.id === 'text_mm2y2ah2');

    const candEmail     = normEmail(ev?.text || '');
    const candIp        = normIp(iv?.text || '');
    const candPhoneText = pv?.text || '';
    const candPhoneTail = phoneTail(candPhoneText);
    const candName      = item.name || '';
    const candKey       = nameKey(candName);

    const emailMatch = !!(newEmail     && candEmail     && newEmail     === candEmail);
    const phoneMatch = !!(newPhoneTail && candPhoneTail && newPhoneTail === candPhoneTail);
    const ipMatch    = !!(newIp        && candIp        && newIp        === candIp);
    const nameMatch  = !!(newKey       && candKey       && newKey       === candKey);

    const matchCount = [emailMatch, phoneMatch, ipMatch, nameMatch].filter(Boolean).length;
    const createdMs  = new Date(item.created_at || 0).getTime();

    // Same-household detection: an IP match on its own is normally too
    // noisy to flag (universities, offices and mobile CGNAT share IPs
    // across strangers). But when the original lead is RECENT, a shared
    // IP usually means the same household — e.g. a parent and student
    // enquiring separately from home wifi. Flag those too.
    const RECENT_IP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
    const ipOnlyRecent = matchCount === 1 && ipMatch && (Date.now() - createdMs) < RECENT_IP_WINDOW_MS;

    if (matchCount < 2 && !ipOnlyRecent) continue;
    const score = matchCount * 1e13 + createdMs;
    if (best && score <= best.score) continue;

    let assignees = [], assigneeIds = [];
    const peopleCol = item.column_values?.find(c => c.id === 'people_1');
    if (peopleCol?.value) {
      try {
        const val = JSON.parse(peopleCol.value);
        const personsArr = val?.personsAndTeams || [];
        assigneeIds = personsArr.filter(pt => pt.kind === 'person').map(pt => pt.id);
        const textVal = peopleCol.text || '';
        if (textVal) assignees = textVal.split(',').map(s => s.trim()).filter(Boolean);
      } catch(e) {
        if (peopleCol.text) assignees = [peopleCol.text];
      }
    }

    best = {
      score,
      id:            item.id,
      name:          candName,
      created_at:    item.created_at,
      assignees,
      assigneeIds,
      originalName:  candName,
      originalEmail: ev?.text || '',
      originalPhone: candPhoneText,
      originalIp:    candIp,
      matchCount,
      emailMatch,
      phoneMatch,
      ipMatch,
      nameMatch,
    };
  }

  // Drop assignments to deactivated/removed Monday users. If ALL original
  // assignees are gone, capture their names so pushToMonday can append a
  // "(previously X's lead)" suffix to the item name.
  if (best && best.assigneeIds.length > 0) {
    const originalIds = best.assigneeIds.slice();
    const { failed, valid, nameById } = await verifyMondayUsers(originalIds);
    best.assigneeIds = originalIds.filter(id => valid.has(Number(id)));
    if (best.assigneeIds.length === 0 && !failed) {
      const removed = originalIds.map((id, i) =>
        nameById[Number(id)] || best.assignees[i] || 'a former colleague'
      );
      best.removedAssignees = [...new Set(removed)];
    }
  }

  return best;
}

// ──────────────────────────────────────────────────────────────
//  GOOGLE ADS — Server-side conversion upload (Data Manager API)
//  Migrated from googleads.googleapis.com:uploadClickConversions.
// ──────────────────────────────────────────────────────────────
const {
  conversionDestination,
  buildUserIdentifiers,
  ingestEvents,
  consentForLead
} = require('./_dataManager.js');

async function uploadGoogleAdsConversion (p) {
  const nameParts = (p.full_name || '').trim().split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || '';
  const lastName  = nameParts.slice(1).join(' ');

  // Always server "now" — the conversion moment is the server receiving
  // the request, not whatever p.submitted_at the visitor's browser sent.
  // Client clock skew or a stale/cached form load can push that value
  // outside Google's acceptable event time window (EVENT_TIME_INVALID).
  const eventTimestamp = new Date().toISOString();

  // gclid / gbraid / wbraid are still a oneof on Data Manager events.
  // Priority unchanged: gclid > gbraid (iOS web) > wbraid (iOS app).
  const adIdentifiers = {};
  if      (p.gclid)  adIdentifiers.gclid  = p.gclid;
  else if (p.gbraid) adIdentifiers.gbraid = p.gbraid;
  else if (p.wbraid) adIdentifiers.wbraid = p.wbraid;

  const userIdentifiers = buildUserIdentifiers({
    email: p.email, phone: p.phone, firstName, lastName, regionCode: 'GB'
  });

  // Google rejects an event with neither a click id nor a user identifier —
  // there is nothing to match it to. Skip rather than send a doomed request.
  if (!Object.keys(adIdentifiers).length && !userIdentifiers.length) {
    console.log('Skipping upload — no click id and no email/phone to match on');
    return { skipped: true, reason: 'no_identifiers' };
  }

  const event = {
    destinationReferences: ['sl-step1-new'],
    transactionId:         String(p.session_id || p.email || Date.now()),
    eventTimestamp,
    eventSource:           'WEB',
    ...(Object.keys(adIdentifiers).length ? { adIdentifiers } : {}),
    userData: { userIdentifiers },
    currency:        'GBP',
    conversionValue: 1.0
  };

  const body = {
    destinations: [
      conversionDestination({
        conversionActionId: process.env.GOOGLE_ADS_CONVERSION_ACTION_ID,
        reference:          'sl-step1-new'
      })
    ],
    events:  [event],
    consent: consentForLead(p.marketing_opt_in)
  };

  console.log('Data Manager events:ingest payload:', JSON.stringify({
    customerId:         (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, ''),
    conversionActionId: process.env.GOOGLE_ADS_CONVERSION_ACTION_ID,
    hasGclid:           !!p.gclid,
    hasGbraid:          !!p.gbraid,
    hasWbraid:          !!p.wbraid,
    identifierCount:    event.userData.userIdentifiers.length,
    consent:            body.consent
  }));

  const result = await ingestEvents(body);
  console.log('Data Manager events:ingest OK — requestId:', result?.requestId || '(no id)');
  return result;
}

// ──────────────────────────────────────────────────────────────
//  EMAIL 1 — Guest confirmation
// ──────────────────────────────────────────────────────────────

// ── RESPONSE TIME LOGIC ──────────────────────────────────────
const CLOSURES = [
  // 2025
  { name:'Easter',                 closed:'2025-04-18', reopen:'2025-04-23' },
  { name:'Early May Bank Holiday', closed:'2025-05-05', reopen:'2025-05-06' },
  { name:'Spring Bank Holiday',    closed:'2025-05-26', reopen:'2025-05-27' },
  { name:'Summer Bank Holiday',    closed:'2025-08-25', reopen:'2025-08-26' },
  { name:'Christmas',              closed:'2025-12-25', reopen:'2025-12-29' },
  // 2026
  { name:'New Year',               closed:'2026-01-01', reopen:'2026-01-02' },
  { name:'Easter',                 closed:'2026-04-03', reopen:'2026-04-07' },
  { name:'Early May Bank Holiday', closed:'2026-05-04', reopen:'2026-05-05' },
  { name:'Spring Bank Holiday',    closed:'2026-05-25', reopen:'2026-05-26' },
  { name:'Summer Bank Holiday',    closed:'2026-08-31', reopen:'2026-09-01' },
  { name:'Christmas',              closed:'2026-12-25', reopen:'2026-12-29' },
  // 2027
  { name:'New Year',               closed:'2027-01-01', reopen:'2027-01-04' },
  { name:'Easter',                 closed:'2027-03-26', reopen:'2027-03-31' },
  { name:'Early May Bank Holiday', closed:'2027-05-03', reopen:'2027-05-04' },
  { name:'Spring Bank Holiday',    closed:'2027-05-31', reopen:'2027-06-01' },
  { name:'Summer Bank Holiday',    closed:'2027-08-30', reopen:'2027-08-31' },
  { name:'Christmas',              closed:'2027-12-27', reopen:'2027-12-30' },
];

function getResponseStatus(submittedAt) {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  // Use submission time in UK timezone
  const now = submittedAt ? new Date(submittedAt) : new Date();
  const ukStr = now.toLocaleString('en-GB', { timeZone: 'Europe/London',
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12: false });
  // Parse "DD/MM/YYYY, HH:MM"
  const [datePart, timePart] = ukStr.split(', ');
  const [dd, mm, yyyy] = datePart.split('/').map(Number);
  const [hh, mi]       = timePart.split(':').map(Number);
  const dayOfWeek      = new Date(yyyy, mm - 1, dd).getDay(); // 0=Sun,6=Sat
  const minuteOfDay    = hh * 60 + mi;
  const inOffice       = minuteOfDay >= 10 * 60 && minuteOfDay < 18 * 60; // 10am–6pm

  // Today as YYYY-MM-DD string for closure comparison
  const todayStr = `${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;

  // Check bank holiday / closure
  for (const c of CLOSURES) {
    if (todayStr >= c.closed && todayStr < c.reopen) {
      const reopenDate  = new Date(c.reopen);
      const reopenDay   = reopenDate.getDate();
      const reopenMonth = MONTHS[reopenDate.getMonth()];
      return {
        state:       'holiday',
        color:       'amber',
        heading:     `From ${reopenDay} ${reopenMonth}`,
        body:        `Our offices are closed for the ${c.name} period. We\u2019ll respond to all enquiries as soon as we\u2019re back on ${reopenDay} ${reopenMonth}.`,
        bodyTextEnd: `from ${reopenDay} ${reopenMonth}`,
      };
    }
  }

  // Weekend (Sat=6, Sun=0) or Friday after 6pm
  const isFriAfter6  = dayOfWeek === 5 && minuteOfDay >= 18 * 60;
  const isSat        = dayOfWeek === 6;
  const isSun        = dayOfWeek === 0;
  if (isFriAfter6 || isSat || isSun) {
    return {
      state:       'weekend',
      color:       'amber',
      heading:     'Monday',
      body:        'Your enquiry came in over the weekend \u2014 we\u2019ll be back in touch first thing on Monday morning.',
      bodyTextEnd: 'on Monday',
    };
  }

  // Weekday in office hours
  if (inOffice) {
    return {
      state:       'inoffice',
      color:       'green',
      heading:     'Same day, or within one business day',
      body:        'Our team are in the office and will be in touch shortly.',
      bodyTextEnd: 'shortly',
    };
  }

  // Weekday out of hours — next business day
  const tomorrowName = DAYS[(dayOfWeek + 1) % 7];
  return {
    state:       'outofhours',
    color:       'green',
    heading:     'Within one business day',
    body:        `Your enquiry came in outside office hours and will be picked up first thing ${tomorrowName} morning.`,
    bodyTextEnd: 'within one business day',
  };
}

function responseStatusHtml(status) {
  const isAmber = status.color === 'amber';
  const bg      = isAmber ? '#FAEEDA' : '#EAF3DE';
  const dot     = isAmber ? '#BA7517' : '#639922';
  const text    = isAmber ? '#854F0B' : '#3B6D11';
  return `
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;">
    <tr><td>
      <p style="margin:0 0 8px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#B8966E;">Expected response time</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:${bg};border-radius:8px;">
        <tr><td style="padding:13px 16px;">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:top;padding-top:3px;padding-right:10px;">
              <span style="display:block;width:8px;height:8px;border-radius:50%;background:${dot};"></span>
            </td>
            <td style="font-size:13px;color:${text};line-height:1.5;">
              <strong>${status.heading}</strong> \u2014 ${status.body}
            </td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
  </table>`;
}

async function sendGuestConfirmation(p) {
  // Partner portals get their own confirmation. Kept as a separate template
  // rather than branches inside this one: the two differ in header, structure
  // and voice, and the standard email must not be at risk from partner edits.
  const portal = partnerPortal(p);
  if (portal) return sendPartnerGuestConfirmation(p, portal);

  const firstName = (p.full_name || '').split(' ')[0] || 'there';
  const siteUrl   = process.env.SITE_URL || 'https://www.studentluxe.co.uk';
  const isTypeA   = p.enquiry_type === 'A';
  const status    = getResponseStatus(p.submitted_at);

  // Build summary rows
  const rows = [
    isTypeA && p.apartment_ref && ['Apartment',            p.apartment_ref],
    !isTypeA && p.city         && ['City',                 formatCity(p.city)],
    p.apartment_type           && ['Apartment type',       formatAptType(p.apartment_type)],
    !isTypeA && p.budget       && ['Budget per week',      formatBudget(p.budget, p)],
    p.check_in                 && ['Check-in',             formatDate(p.check_in)],
    p.check_out                && ['Check-out',            formatDate(p.check_out)],
    nights(p)                  && ['Stay length',          nights(p) + ' nights'],
    !isTypeA && p.areas        && ['Areas of interest',    formatArea(p.areas)],
    p.response_methods         && ["We\u2019ll try to respond via", p.response_methods],
  ].filter(Boolean);

  const summaryRows = rows.map(([label, value]) => `
    <tr>
      <td style="padding:9px 0;font-size:12px;color:#6b6b6b;border-bottom:0.5px solid #ede9e3;width:50%;">${label}</td>
      <td style="padding:9px 0;font-size:12px;color:#1a1a1a;font-weight:500;border-bottom:0.5px solid #ede9e3;text-align:right;">${escHtml(String(value))}</td>
    </tr>`).join('');

  // Greeting body copy — adapts per enquiry type and response state
  // "A member of our Reservations team..." removed — covered by Expected Response Time section
  const bodyTypeA = isTypeA
    ? `Thank you for your enquiry about <strong>${escHtml(p.apartment_ref || 'your chosen apartment')}</strong> \u2014 we\u2019re checking the latest availability and pricing for your chosen dates.`
    : `Thank you for your <strong>${escHtml(formatCity(p.city) || '')}</strong> apartment enquiry \u2014 we\u2019re curating the best available options for your dates and budget.`;

  const FOOTER_BG = 'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/dc5adc8f-739b-4db0-8698-c08a6e6b85d3/luxury-student-apartments.jpg?content-type=image%2Fjpeg';
  const LOGO_WHITE = 'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/b4112f3c-4153-4544-b7bd-2c93282a68a2/Logo+White+website.png?content-type=image%2Fpng';
  const LOGO_HEADER = 'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/4d6b8086-53ed-4d17-b8f7-20f67be76f41/luxe-white.png?content-type=image%2Fpng';

  const _submittedDate = new Date(p.submitted_at || Date.now()).toLocaleString('en-GB',{day:'numeric',month:'long',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true,timeZone:'Europe/London'});
  // Format: "21 May 2026, 4:57 pm" → "on 21 May 2026 at 4:57 pm"
  // Node 20+ ICU renders "21 May 2026 at 4:57 pm" instead of using a comma, so
  // the optional "at" is swallowed here rather than doubled up in the output.
  const _dateParts = _submittedDate.match(/^(\d+ \w+ \d+),?\s+(?:at\s+)?(.+)$/);
  const _dateFormatted = _dateParts ? `on ${_dateParts[1]} at ${_dateParts[2]}` : _submittedDate;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your enquiry with us \u2014 Student Luxe</title>
<style>
@media only screen and (max-width:600px){
  .sl-outer-wrap { padding:0 !important; }
  .sl-card { border-radius:0 !important; border-left:none !important; border-right:none !important; }
  .sl-body-cell { padding:22px 20px 0 !important; }
  .sl-tick-td { display:block !important; width:100% !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" class="sl-outer-wrap" style="background:#f4f1ec;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" class="sl-card" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.3);">

  <!-- HEADER -->
  <tr><td style="background:#B8966E;padding:22px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle;">
        <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:24px;font-weight:400;color:#ffffff;letter-spacing:-0.02em;line-height:1.2;">Your enquiry with us.</p>
        <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.7);">${_dateFormatted}</p>
      </td>
      <td style="text-align:right;vertical-align:middle;">
        <img src="${LOGO_HEADER}" alt="Student Luxe" style="height:40px;width:auto;display:block;margin-left:auto;">
      </td>
    </tr></table>
  </td></tr>

  <!-- BODY -->
  <tr><td class="sl-body-cell" style="background:#ffffff;padding:28px 32px 0;">

    <p style="margin:0 0 14px;font-size:14px;color:#1a1a1a;line-height:1.5;">Dear ${escHtml(firstName)},</p>
    <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.5;">${bodyTypeA}</p>

    ${responseStatusHtml(status)}

    <!-- DIVIDER -->
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:0.5px solid #ede9e3;padding-top:0;margin-top:22px;display:block;height:22px;"></td></tr></table>

    <!-- ABOUT -->
    <p style="margin:0 0 10px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#B8966E;">About Student Luxe</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f2eb;border-radius:10px;">
      <tr><td style="padding:18px 20px;">
        <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:15px;font-weight:400;color:#1a1a1a;letter-spacing:-0.01em;">Simply unpack and <em style="color:#B8966E;">start living.</em></p>
        <p style="margin:0 0 16px;font-size:12.5px;color:#6b6b6b;line-height:1.5;">All of our professionally-managed apartments are private, furnished, set up and ready to move in. All bills, Wi-Fi, housekeeping and resident support are included as standard. No guarantors or credit checks required.</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="50%" class="sl-tick-td" style="padding:4px 0;font-size:12px;color:#1a1a1a;vertical-align:middle;">
              <span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:14px;font-size:8px;color:#B8966E;margin-right:7px;vertical-align:middle;">&#10003;</span>Fully furnished &amp; equipped</td>
            <td width="50%" class="sl-tick-td" style="padding:4px 0;font-size:12px;color:#1a1a1a;vertical-align:middle;">
              <span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:14px;font-size:8px;color:#B8966E;margin-right:7px;vertical-align:middle;">&#10003;</span>Weekly housekeeping</td>
          </tr>
          <tr>
            <td width="50%" class="sl-tick-td" style="padding:4px 0;font-size:12px;color:#1a1a1a;vertical-align:middle;">
              <span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:14px;font-size:8px;color:#B8966E;margin-right:7px;vertical-align:middle;">&#10003;</span>All bills &amp; everything included</td>
            <td width="50%" class="sl-tick-td" style="padding:4px 0;font-size:12px;color:#1a1a1a;vertical-align:middle;">
              <span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:14px;font-size:8px;color:#B8966E;margin-right:7px;vertical-align:middle;">&#10003;</span>Flexible lengths of stay</td>
          </tr>
          <tr>
            <td width="50%" class="sl-tick-td" style="padding:4px 0;font-size:12px;color:#1a1a1a;vertical-align:middle;">
              <span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:14px;font-size:8px;color:#B8966E;margin-right:7px;vertical-align:middle;">&#10003;</span>Hotel-style amenities</td>
            <td width="50%" class="sl-tick-td" style="padding:4px 0;font-size:12px;color:#1a1a1a;vertical-align:middle;">
              <span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:14px;font-size:8px;color:#B8966E;margin-right:7px;vertical-align:middle;">&#10003;</span>Ongoing resident support</td>
          </tr>
        </table>
      </td></tr>
    </table>

    <!-- DIVIDER -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0;"><tr><td style="border-top:0.5px solid #ede9e3;"></td></tr></table>

    <!-- SUMMARY -->
    <p style="margin:18px 0 10px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#B8966E;">What you've told us so far</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tbody>${summaryRows}</tbody>
    </table>

    ${p.message ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;">
      <tr><td style="background:#f7f2eb;border-left:3px solid #B8966E;padding:12px 16px;">
        <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#B8966E;">Your message</p>
        <p style="margin:0;font-size:13px;color:#1a1a1a;line-height:1.7;font-style:italic;">"${escHtml(p.message)}"</p>
      </td></tr>
    </table>` : ''}

    <div style="height:28px;"></div>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background-image:url('${FOOTER_BG}');background-size:cover;background-position:center top;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(139,107,69,0.90);">
      <tr><td style="padding:28px 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;"><tr>
          <td style="vertical-align:top;">
            <img src="${LOGO_WHITE}" alt="Student Luxe" style="height:22px;width:auto;display:block;margin-bottom:12px;opacity:0.95;">
            <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.65);line-height:1.85;">Dog &amp; Duck Yard, Princeton St<br>London, WC1R 4BH<br>+44 (0)203 007 0017<br>Mon\u2013Fri, 10am\u20136pm GMT</p>
          </td>
          <td style="text-align:right;vertical-align:top;padding-top:34px;">
            <a href="${siteUrl}/services" style="display:block;font-size:11px;color:rgba(255,255,255,0.75);text-decoration:none;line-height:2.1;">What\u2019s included</a>
            <a href="${siteUrl}/our-reviews" style="display:block;font-size:11px;color:rgba(255,255,255,0.75);text-decoration:none;line-height:2.1;">Reviews</a>
            <a href="${siteUrl}/faqs" style="display:block;font-size:11px;color:rgba(255,255,255,0.75);text-decoration:none;line-height:2.1;">FAQs</a>
            <a href="${siteUrl}/meet-the-team" style="display:block;font-size:11px;color:rgba(255,255,255,0.75);text-decoration:none;line-height:2.1;">Meet the team</a>
          </td>
        </tr></table>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-top:0.5px solid rgba(255,255,255,0.2);padding-top:16px;margin-top:0;"><tr>
          <td><p style="margin:0;font-size:10px;color:rgba(255,255,255,0.4);line-height:1.6;">&copy; 2026 Student Luxe Apartments. All rights reserved.</p></td>
          <td style="text-align:right;"><p style="margin:0;font-size:10px;color:rgba(255,255,255,0.4);line-height:1.6;">If you didn\u2019t submit this enquiry, please disregard.</p></td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  if (!p.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) {
    console.warn('Guest confirmation skipped — invalid email:', p.email);
    return;
  }

  const cityLabel = formatCity(p.city) || '';
  return resendSend({
    from:    `${process.env.FROM_NAME || 'Student Luxe'} <${process.env.FROM_EMAIL}>`,
    to:      [p.email],
    subject: isTypeA
      ? `Your enquiry about ${escHtml(p.apartment_ref || 'your apartment')}`
      : `Your ${cityLabel} apartment enquiry`.trim(),
    html
  });
}
// ──────────────────────────────────────────────────────────────
//  EMAIL 1b — Guest confirmation, partner portals
// ──────────────────────────────────────────────────────────────
async function sendPartnerGuestConfirmation(p, portal) {
  if (!p.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) {
    console.warn('Partner guest confirmation skipped — invalid email:', p.email);
    return;
  }

  const firstName  = (p.full_name || '').split(' ')[0] || 'there';
  const nightCount = nights(p);

  const _submitted = new Date(p.submitted_at || Date.now()).toLocaleString('en-GB',{day:'numeric',month:'long',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true,timeZone:'Europe/London'});
  // Node 20+ ICU already renders "16 July 2026 at 4:57 pm"; older builds used a
  // comma. Swallow either separator so we don't emit "at at".
  const _parts     = _submitted.match(/^(\d+ \w+ \d+),?\s+(?:at\s+)?(.+)$/);
  const _dateFmt   = _parts ? `on ${_parts[1]} at ${_parts[2]}` : _submitted;

  // Each cell renders only when we actually hold the value, so a sparse
  // enquiry produces a tidy card rather than a grid of dashes.
  const cell = (label, value, accent) => value ? `
            <td class="sl-half" width="50%" style="vertical-align:top;padding-bottom:16px;">
              <p style="margin:0 0 3px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:#9b9b9b;">${label}</p>
              <p style="margin:0;font-size:13.5px;color:${accent ? '#B8966E' : '#1a1a1a'};font-weight:500;">${escHtml(String(value))}</p>
            </td>` : '<td class="sl-half" width="50%"></td>';

  const step = (n, title, body) => `
          <tr>
            <td width="26" style="vertical-align:top;padding:0 0 16px;"><span style="font-family:Georgia,serif;font-size:15px;color:#B8966E;">${n}</span></td>
            <td style="vertical-align:top;padding:0 0 16px;">
              <p style="margin:0 0 3px;font-size:13px;color:#1a1a1a;font-weight:500;">${title}</p>
              <p style="margin:0;font-size:12px;color:#6b6b6b;line-height:1.5;">${body}</p>
            </td>
          </tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your accommodation enquiry — ${escHtml(portal.school)}</title>
<style>
@media only screen and (max-width:600px){
  .sl-outer-wrap { padding:0 !important; }
  .sl-card { border-radius:0 !important; border-left:none !important; border-right:none !important; }
  .sl-body-cell { padding:22px 20px 0 !important; }
  .sl-half { display:block !important; width:100% !important; padding-bottom:14px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" class="sl-outer-wrap" style="background:#f4f1ec;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" class="sl-card" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;border:0.5px solid rgba(0,0,0,0.15);">

  <!-- HEADER -->
  <tr><td style="background:#000000;padding:24px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle;">
        <p style="margin:0 0 7px;font-size:9.5px;letter-spacing:0.2em;text-transform:uppercase;color:#D4B896;">${escHtml(portal.school)}</p>
        <p style="margin:0 0 5px;font-family:Georgia,serif;font-size:24px;font-weight:400;color:#ffffff;letter-spacing:-0.02em;line-height:1.2;">Your accommodation enquiry.</p>
        <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.5);">${_dateFmt}</p>
      </td>
      <td style="text-align:right;vertical-align:middle;">
        <p style="margin:0 0 2px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:rgba(255,255,255,0.45);line-height:1.6;">Managed by</p>
        <p style="margin:0;font-family:Georgia,serif;font-style:italic;font-size:17px;color:#ffffff;">Student Luxe</p>
      </td>
    </tr></table>
  </td></tr>

  <!-- BODY -->
  <tr><td class="sl-body-cell" style="background:#ffffff;padding:28px 32px 0;">

    <p style="margin:0 0 14px;font-size:14px;color:#1a1a1a;line-height:1.5;">Dear ${escHtml(firstName)},</p>
    <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.5;">Thank you for your enquiry. We are the accommodation office for <strong>${escHtml(portal.school)}</strong>, and we will put together a shortlist of options matched to your needs, budget and lifestyle.</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0;"><tr><td style="border-top:0.5px solid #ede9e3;"></td></tr></table>

    <!-- WHAT HAPPENS NEXT -->
    <p style="margin:18px 0 10px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#B8966E;">What happens next</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f2eb;border-radius:10px;">
      <tr><td style="padding:20px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${step('01', 'A Student Luxe advisor makes contact', 'On your preferred channel, to talk through areas, budget and dates.')}
          ${step('02', 'Get a shortlist of recommendations', 'Receive options for your preferences &amp; price-range. In-person &amp; virtual viewings possible.')}
          <tr>
            <td width="26" style="vertical-align:top;"><span style="font-family:Georgia,serif;font-size:15px;color:#B8966E;">03</span></td>
            <td style="vertical-align:top;">
              <p style="margin:0 0 3px;font-size:13px;color:#1a1a1a;font-weight:500;">Book an accommodation option</p>
              <p style="margin:0;font-size:12px;color:#6b6b6b;line-height:1.5;">Time to begin your exciting new chapter at ${escHtml(portal.school)}.</p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0;"><tr><td style="border-top:0.5px solid #ede9e3;"></td></tr></table>

    <!-- YOUR ENQUIRY -->
    <p style="margin:18px 0 10px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#B8966E;">Your enquiry</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:0.5px solid rgba(184,150,110,0.35);border-radius:10px;">
      <tr><td style="padding:20px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            ${cell('Accommodation type', formatAptType(p.apartment_type))}
            ${cell('Guide price', p.budget ? formatBudget(p.budget, p) + ' /week' : '', true)}
          </tr>
          <tr>
            ${cell('Check-in', formatDate(p.check_in))}
            ${cell('Check-out', formatDate(p.check_out))}
          </tr>
          <tr>
            ${cell('Course', p.course)}
            ${cell('Preferred area', formatArea(p.areas))}
          </tr>
        </table>
        ${nightCount ? `
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;">
          <tr><td style="border-top:0.5px solid rgba(184,150,110,0.25);padding-top:12px;">
            <p style="margin:0;font-size:11.5px;color:#9b9b9b;">Staying <span style="color:#B8966E;">${nightCount} nights</span></p>
          </td></tr>
        </table>` : ''}
      </td></tr>
    </table>

    ${p.message ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;">
      <tr><td style="background:#f7f2eb;border-left:3px solid #B8966E;padding:12px 16px;">
        <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#B8966E;">Your message</p>
        <p style="margin:0;font-size:13px;color:#1a1a1a;line-height:1.7;font-style:italic;">"${escHtml(p.message)}"</p>
      </td></tr>
    </table>` : ''}

    <p style="margin:12px 0 0;font-size:11.5px;color:#9b9b9b;line-height:1.6;">Anything to change? Just reply to this email and we will update it.</p>

    <div style="height:28px;"></div>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#000000;padding:26px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;"><tr>
      <td style="vertical-align:top;">
        <p style="margin:0 0 3px;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:#D4B896;">Accommodation office</p>
        <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:15px;color:#ffffff;">${escHtml(portal.school)} <span style="color:rgba(255,255,255,0.35);">&#215;</span> <em>Student Luxe</em></p>
        <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.55);line-height:1.85;">Dog &amp; Duck Yard, Princeton St<br>London, WC1R 4BH<br>+44 (0)203 007 0017<br>Mon–Fri, 10am–6pm GMT</p>
      </td>
    </tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:0.5px solid rgba(255,255,255,0.15);"><tr>
      <td style="padding-top:16px;"><p style="margin:0;font-size:10px;color:rgba(255,255,255,0.35);line-height:1.6;">&copy; ${new Date().getFullYear()} Student Luxe Apartments. All rights reserved.</p></td>
      <td style="text-align:right;padding-top:16px;"><p style="margin:0;font-size:10px;color:rgba(255,255,255,0.35);line-height:1.6;">If you didn’t submit this enquiry, please disregard.</p></td>
    </tr></table>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  return resendSend({
    from:    `${portal.fromName} <${portal.fromEmail}>`,
    to:      [p.email],
    subject: `Your ${portal.school} accommodation enquiry`,
    html
  });
}

// ──────────────────────────────────────────────────────────────
//  EMAIL 2 — Team notification
// ──────────────────────────────────────────────────────────────
async function sendTeamNotification(p, mondayId, mondayError, duplicateOf, submitterIp, leadSource, leadChannel) {
  const isTypeA    = p.enquiry_type === 'A';
  const guestName  = p.full_name || 'New enquiry';
  const nightCount = nights(p);
  const portal     = partnerPortal(p);

  const submittedFormatted = p.submitted_at
    ? new Date(p.submitted_at).toLocaleString('en-GB', {
        day:'numeric', month:'long', year:'numeric',
        hour:'numeric', minute:'2-digit', hour12:true,
        timeZone:'Europe/London'
      }).replace(', ', ' — ')
    : new Date().toLocaleString('en-GB', {
        day:'numeric', month:'long', year:'numeric',
        hour:'numeric', minute:'2-digit', hour12:true,
        timeZone:'Europe/London'
      }).replace(', ', ' — ');

  const crmUrl = mondayId
    ? `https://studentluxe.monday.com/boards/${MONDAY_BOARD}/pulses/${mondayId}`
    : `https://studentluxe.monday.com/boards/${MONDAY_BOARD}/views/205648977`;

  // When the Monday write fails, this email is the ONLY copy of the lead's
  // attribution — so dump every tracking field into the banner for manual
  // entry. Normally these live in the Monday row and are omitted here.
  const trackingRescueRows = mondayError ? (function () {
    const row = (label, value) => value ? `
        <tr>
          <td style="padding:3px 0;font-size:10.5px;color:#856404;width:130px;vertical-align:top;">${label}</td>
          <td style="padding:3px 0;font-size:10.5px;color:#5a4310;font-weight:500;word-break:break-all;">${escHtml(value)}</td>
        </tr>` : '';
    return `
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;border-top:1px dashed #f0ad4e;padding-top:8px;">
          <tr><td colspan="2" style="padding:8px 0 4px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#856404;font-weight:600;">Full tracking — copy into the Monday row</td></tr>
          ${row('Campaign',        p.utm_campaign)}
          ${row('Ad group',        p.utm_adgroup)}
          ${row('Search term',     p.utm_term)}
          ${row('Match type',      p.utm_matchtype)}
          ${row('gclid',           p.gclid)}
          ${row('gbraid',          p.gbraid)}
          ${row('wbraid',          p.wbraid)}
          ${row('fbclid',          p.fbclid)}
          ${row('Session ID',      p.session_id)}
          ${row('Landing page',    p.landing_page)}
          ${row('First campaign',  p.first_campaign)}
          ${row('First referrer',  p.first_referrer)}
          ${row('Visited paths',   p.visited_paths)}
          ${row('Submitter IP',    submitterIp)}
        </table>`;
  })() : '';

  const mondayErrorBanner = mondayError ? `
  <tr><td style="padding:0 28px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff3cd;border:1px solid #f0ad4e;border-radius:8px;">
      <tr><td style="padding:12px 16px;">
        <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#856404;">⚠️ Monday CRM push failed — add this lead manually</p>
        <p style="margin:0;font-size:11px;color:#856404;line-height:1.5;">Error: <code style="font-size:10px;background:rgba(0,0,0,0.06);padding:1px 4px;border-radius:3px;">${escHtml(mondayError)}</code></p>
        ${trackingRescueRows}
      </td></tr>
    </table>
  </td></tr>` : '';

  const dupBannerHtml = duplicateOf ? (function() {
    const originalFormatted = duplicateOf.created_at
      ? new Date(duplicateOf.created_at).toLocaleString('en-GB', {
          day:'numeric', month:'long', year:'numeric',
          hour:'numeric', minute:'2-digit', hour12:true,
          timeZone:'Europe/London'
        })
      : '—';

    const assigneePills = duplicateOf.assignees && duplicateOf.assignees.length > 0
      ? duplicateOf.assignees.map(name => {
          const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0,2);
          return `<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#1a1a1a;margin-right:8px;"><span style="width:24px;height:24px;border-radius:50%;background:#B8966E;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:500;color:#fff;">${initials}</span>${escHtml(name)}</span>`;
        }).join('')
      : '<span style="font-size:12px;color:#9b9b9b;">Unassigned</span>';

    const matchTagHtml = `<span style="display:inline-block;font-size:9px;letter-spacing:0.06em;text-transform:uppercase;background:#f7f2eb;color:#9b7540;border:0.5px solid rgba(184,150,110,0.35);border-radius:3px;padding:1px 6px;margin-left:5px;vertical-align:middle;">match</span>`;

    const compareRow = (label, origVal, newVal, isMatch) => {
      const matchTag = isMatch ? matchTagHtml : '';
      return `<tr>
        <td style="padding:12px 16px;border-top:0.5px solid #e8e4de;border-right:0.5px solid #e8e4de;vertical-align:top;width:50%;">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9b9b9b;">${label}</p>
          <p style="margin:0;font-size:13px;color:#1a1a1a;font-weight:500;">${escHtml(origVal || '—')}</p>
        </td>
        <td style="padding:12px 16px;border-top:0.5px solid #e8e4de;vertical-align:top;width:50%;">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9b9b9b;">${label}</p>
          <p style="margin:0;font-size:13px;font-weight:500;color:${isMatch ? '#B8966E' : '#1a1a1a'};">${escHtml(newVal || '—')}${matchTag}</p>
        </td>
      </tr>`;
    };

    return `
  <tr><td style="background:#fffcf2;border-top:3px solid #e8c96b;padding:14px 32px;font-size:13px;color:#5a4310;line-height:1.65;">
    ⚠️ &nbsp;Possible duplicate, ${duplicateOf.matchCount} of 4 signals match. It's been added to the Leads Board with 'Possible Duplicate' tagged, and the salesperson assigned to the original lead has been automatically assigned to it.
  </td></tr>
  <tr><td style="background:#ffffff;padding:20px 32px 0;">
    <p style="margin:0 0 14px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#B8966E;">Original Lead vs. New Lead</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:0.5px solid #e8e4de;border-radius:10px;overflow:hidden;border-collapse:separate;border-spacing:0;margin-bottom:14px;">
      <tr>
        <td width="50%" style="padding:8px 16px;background:#f7f2eb;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9b7540;border-bottom:0.5px solid #e8e4de;">Original Lead</td>
        <td width="50%" style="padding:8px 16px;background:#0d1a2e;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.6);border-bottom:0.5px solid #e8e4de;border-left:0.5px solid #e8e4de;">New Lead</td>
      </tr>
      ${compareRow('Name',       duplicateOf.originalName,  p.full_name || '', duplicateOf.nameMatch)}
      ${compareRow('Email',      duplicateOf.originalEmail, p.email     || '', duplicateOf.emailMatch)}
      ${compareRow('Phone',      duplicateOf.originalPhone, p.phone     || '', duplicateOf.phoneMatch)}
      ${compareRow('IP address', duplicateOf.originalIp,    submitterIp || '', duplicateOf.ipMatch)}
      ${compareRow('Lead created', originalFormatted, submittedFormatted, false)}
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:0.5px solid #e8e4de;border-radius:10px;padding:12px 16px;margin-bottom:20px;">
      <tr>
        <td style="font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9b9b9b;vertical-align:middle;width:160px;">Original lead assigned to</td>
        <td style="vertical-align:middle;">${assigneePills}</td>
      </tr>
    </table>
  </td></tr>`;
  })() : '';

  const field = (label, value) => value ? `
    <td style="padding:0 20px 14px 0;vertical-align:top;width:50%;">
      <p style="margin:0 0 2px;font-size:10px;letter-spacing:0.1em;color:#9b9b9b;text-transform:uppercase;">${label}</p>
      <p style="margin:0;font-size:13px;color:#1a1a1a;font-weight:500;">${escHtml(String(value))}</p>
    </td>` : '';

  // Same as field(), but the value renders as a pill. Used for the one fact the
  // team triages a partner lead on.
  const fieldPill = (label, value) => value ? `
    <td style="padding:0 20px 14px 0;vertical-align:top;width:50%;">
      <p style="margin:0 0 5px;font-size:10px;letter-spacing:0.1em;color:#9b9b9b;text-transform:uppercase;">${label}</p>
      <span style="display:inline-block;padding:7px 16px;border-radius:100px;background:rgba(184,150,110,0.14);border:0.5px solid rgba(184,150,110,0.45);font-size:13.5px;font-weight:500;color:#8a6540;line-height:1.3;">${escHtml(String(value))}</span>
    </td>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>New enquiry — ${escHtml(guestName)}</title>
<style>
@media only screen and (max-width:600px){
  .sl-t-outer { padding:0 !important; }
  .sl-t-card { border-radius:0 !important; border-left:none !important; border-right:none !important; }
  .sl-t-body { padding:16px 20px 0 !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" class="sl-t-outer" style="background:#f4f1ec;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" class="sl-t-card" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.3);">
  <tr><td style="background:#B8966E;padding:22px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle;">
        <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:22px;font-weight:400;color:#ffffff;letter-spacing:-0.02em;line-height:1.2;">${escHtml(guestName)}</p>
        <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.75);">${submittedFormatted}</p>
      </td>
      <td style="text-align:right;vertical-align:middle;">
        <img src="https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/4d6b8086-53ed-4d17-b8f7-20f67be76f41/luxe-white.png?content-type=image%2Fpng" alt="Student Luxe" style="height:44px;width:auto;display:block;margin-left:auto;">
      </td>
    </tr></table>
  </td></tr>
  ${mondayErrorBanner}
  ${dupBannerHtml}
  <tr><td class="sl-t-body" style="background:#ffffff;padding:20px 32px 0;">
    <p style="margin:0 0 10px;"><span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:500;letter-spacing:0.06em;background:${isTypeA ? 'rgba(29,158,117,0.12)' : 'rgba(184,150,110,0.12)'};color:${isTypeA ? '#0F6E56' : '#8a6540'};border:0.5px solid ${isTypeA ? 'rgba(29,158,117,0.4)' : 'rgba(184,150,110,0.4)'};">${isTypeA ? 'Check apartment availability' : 'Send guest options'}</span></p>
    <p style="margin:0;font-size:13px;color:#1a1a1a;line-height:1.75;">${isTypeA
      ? `${escHtml(p.apartment_ref || '')}${p.apartment_type ? ' — ' + formatAptType(p.apartment_type) : ''}${nightCount ? ' &nbsp;·&nbsp; ' + nightCount + ' nights' : ''}${p.check_in ? ' &nbsp;·&nbsp; ' + formatDate(p.check_in) + ' → ' + formatDate(p.check_out) : ''}`
      : `${formatCity(p.city) || ''}${p.apartment_type ? ' — ' + formatAptType(p.apartment_type) : ''}${nightCount ? ' &nbsp;·&nbsp; ' + nightCount + ' nights' : ''}${p.check_in ? ' &nbsp;·&nbsp; ' + formatDate(p.check_in) + ' → ' + formatDate(p.check_out) : ''}${p.budget && p.enquiry_type !== 'A' ? ' &nbsp;·&nbsp; ' + formatBudget(p.budget, p) + '/wk' : ''}`
    }</p>
  </td></tr>
  <tr><td style="background:#ffffff;padding:0 32px;"><hr style="border:none;border-top:0.5px solid #ede9e3;margin:18px 0;"></td></tr>
  <tr><td style="background:#ffffff;padding:0 32px 18px;">
    <p style="margin:0 0 12px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Contact</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>${field('Name', p.full_name)}${field('Email', p.email)}</tr>
      <tr>${field('Phone', p.phone)}${field('Respond via', p.response_methods)}</tr>
      <tr>${field('Timezone', p.timezone || '—')}</tr>
    </table>
  </td></tr>
  <tr><td style="background:#ffffff;padding:0 32px 18px;">
    <p style="margin:0 0 12px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Stay details</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${portal ? `
      <tr>${field('City', formatCity(p.city))}${fieldPill('Accommodation type', formatAptType(p.apartment_type))}</tr>
      <tr>${field('Course', p.course)}${field('Guide price', formatBudget(p.budget, p))}</tr>
      <tr>${field('Check-in', formatDate(p.check_in))}${field('Check-out', formatDate(p.check_out))}</tr>
      <tr>${field('Nights', nightCount)}${field('Areas', formatArea(p.areas))}</tr>
      <tr>${field('University', portal.channel)}</tr>` : `
      ${isTypeA
        ? `<tr>${field('Apartment', p.apartment_ref)}${field('Apartment type', formatAptType(p.apartment_type))}</tr>`
        : `<tr>${field('City', formatCity(p.city))}${field('Apartment type', formatAptType(p.apartment_type))}</tr>`}
      <tr>${field('Check-in', formatDate(p.check_in))}${field('Check-out', formatDate(p.check_out))}</tr>
      <tr>${field('Nights', nightCount)}${field('Budget / week', p.enquiry_type !== 'A' ? formatBudget(p.budget, p) : '')}</tr>
      <tr>${field('Areas', formatArea(p.areas))}${field('Type of stay', formatStayType(p.stay_type, p.university))}</tr>
      <tr>${field('Country of residence', p.nationality)}${field('Lived in city before', p.lived_before)}</tr>`}
    </table>
  </td></tr>
  ${p.message ? `
  <tr><td style="background:#ffffff;padding:0 32px 18px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="background:#f7f2eb;border-left:3px solid #B8966E;border-radius:0 8px 8px 0;padding:12px 16px;">
        <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#B8966E;">Message from guest</p>
        <p style="margin:0;font-size:13px;color:#1a1a1a;line-height:1.7;font-style:italic;">"${escHtml(p.message)}"</p>
      </td></tr>
    </table>
  </td></tr>` : ''}
  <tr><td style="background:#ffffff;padding:0 32px 24px;">
    <p style="margin:0 0 12px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Tracking</p>
    <table cellpadding="0" cellspacing="0" style="background:#f7f2eb;border-radius:8px;padding:10px 16px;width:100%;">
      <tr><td style="padding:3px 0;font-size:11px;color:#9b9b9b;width:160px;">Lead Source (Where)</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;font-weight:500;">${escHtml(leadSource||'—')}</td></tr>
      <tr><td style="padding:3px 0;font-size:11px;color:#9b9b9b;">Lead Source (How)</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;font-weight:500;">${escHtml(leadChannel||'—')}</td></tr>
    </table>
  </td></tr>
  <tr><td style="background:#f7f2eb;padding:16px 32px;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="padding-right:8px;"><a href="mailto:${p.email}" style="display:inline-block;padding:10px 20px;background:#B8966E;border-radius:8px;font-size:12px;font-weight:500;color:#ffffff;text-decoration:none;">Reply by email</a></td>
      <td style="padding-right:8px;"><a href="${crmUrl}" style="display:inline-block;padding:10px 20px;background:#ffffff;border:0.5px solid rgba(184,150,110,0.4);border-radius:8px;font-size:12px;font-weight:500;color:#1a1a1a;text-decoration:none;">View on Leads Board</a></td>
      ${isTypeA && p.apartment_ref ? `<td><a href="https://studentluxe.monday.com/boards/2388987554/views/87174774?term=${encodeURIComponent(p.apartment_ref)}" style="display:inline-block;padding:10px 20px;background:#ffffff;border:0.5px solid rgba(184,150,110,0.4);border-radius:8px;font-size:12px;font-weight:500;color:#1a1a1a;text-decoration:none;">View on Property Board</a></td>` : ''}
    </tr></table>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  return resendSend({
    from:    portal
      ? `${portal.fromName} <${portal.fromEmail}>`
      : `${process.env.FROM_NAME || 'Student Luxe'} <${process.env.FROM_EMAIL}>`,
    to:      [process.env.TEAM_EMAIL, process.env.TEAM_EMAIL_2].filter(Boolean),
    // Reply goes to the guest, not back to the partner alias (which is itself an
    // alias of the team inbox, so Reply would otherwise be self-addressed).
    replyTo: p.email,
    subject: portal
      ? `Marangoni Enquiry - ${formatAptType(p.apartment_type) || 'Accommodation'}${nightCount ? ', ' + nightCount + ' nights' : ''}`
      : isTypeA
      ? `New Guest Enquiry — ${p.apartment_ref || 'Specific Apartment'}${nightCount ? ', ' + nightCount + ' Nights' : ''}`
      : `New Guest Enquiry — ${formatCity(p.city) || 'Unknown City'}${nightCount ? ', ' + nightCount + ' Nights' : ''}`,
    html
  });
}

// ──────────────────────────────────────────────────────────────
//  LEAD SOURCE
// ──────────────────────────────────────────────────────────────
// Co-branded partner portals, keyed by the enquiry_source their form block
// sends. Every lead from one of these is filed as Source "Partnerships".
// Add one entry per new partner portal; all labels must already exist on the
// Leads board or Monday rejects the create.
const PARTNER_PORTALS = {
  'istituto-marangoni-landing': {
    channel:   'Istituto Marangoni',    // dropdown_mkxkfbff + university column
    formName:  'Marangoni Modal Form',  // dropdown_mm1v31yb
    city:      'london',                // text8 + currency, via formatCity(p.city)
    school:    'Istituto Marangoni London',
    // Sends as the partner's own accommodation office. The mailbox is an alias
    // of reservations@, so guest replies land with the team. Domain is verified
    // in Resend, so DKIM/DMARC alignment is unaffected by the display name.
    fromName:  'Marangoni Accommodation Office',
    fromEmail: 'marangoni@studentluxe.co.uk',
  },
};

function partnerPortal(p) {
  return PARTNER_PORTALS[(p.enquiry_source || '').trim()] || null;
}

function computeLeadSource(p) {
  // Partnership portals (co-branded pages hosted for a partner institution)
  // are always credited to the partner, never to the ad or search that first
  // brought the guest to that partner's own site. Checked before every other
  // signal so a stray gclid cannot reclassify the lead as PPC.
  const partner = partnerPortal(p);
  if (partner) return { leadSource: 'Partnerships', leadChannel: partner.channel };

  const hasGclid     = !!p.gclid;
  const hasFbclid    = !!p.fbclid;
  const hasCampaign  = !!(p.utm_campaign || '').trim();
  const hasKeyword   = !!(p.utm_term || '').trim();
  const visitedPaths = (p.visited_paths || '').trim();
  const isDirect     = visitedPaths.startsWith('Direct');
  const isGoogleOrg  = visitedPaths.startsWith('Google Organic');
  const hasVisited   = !!(p.visited_paths || p.landing_page);

  // UTM-based social detection — must come before hasPpcSignal
  const utmSource = (p.utm_source || '').toLowerCase().trim();
  const utmMedium = (p.utm_medium || '').toLowerCase().trim();
  const SOCIAL_SOURCES = ['ig','instagram','facebook','fb','meta','tiktok','linkedin','twitter','x'];
  const SOCIAL_MEDIUMS = ['social','social-media','social_media','paid-social','paid_social','paidsocial'];
  const isUtmSocial = SOCIAL_SOURCES.includes(utmSource) || SOCIAL_MEDIUMS.includes(utmMedium);

  // Bing detection
  const hasMsclkid     = utmSource.includes('bing') && utmMedium.includes('cpc');
  const isBingOrg      = utmSource.includes('bing') && !utmMedium.includes('cpc');
  const visitedHasBing = (p.visited_paths || '').toLowerCase().includes('bing');

  const hasPpcSignal = (hasGclid || hasCampaign || hasKeyword) && !isUtmSocial;

  // Map UTM source to a specific channel label
  function utmSourceToChannel(src) {
    if (['ig','instagram'].includes(src))           return 'Instagram';
    if (['facebook','fb','meta'].includes(src))     return 'Meta Advert';
    if (['tiktok'].includes(src))                   return 'TikTok';
    if (['linkedin'].includes(src))                 return 'From a Friend';
    if (['twitter','x'].includes(src))              return 'Twitter / X';
    return 'Instagram'; // default for generic social medium
  }

  function extractChannel(referrer) {
    if(!referrer) return '';
    try {
      const host = new URL(referrer).hostname.replace('www.', '').replace('search.', '');
      const domainMap = {
        'google.com':'Google Advert','google.co.uk':'Google Advert',
        'bing.com':'Bing','yahoo.com':'Yahoo','duckduckgo.com':'DuckDuckGo',
        'instagram.com':'Instagram','facebook.com':'Meta Advert','meta.com':'Meta Advert',
        'linkedin.com':'From a Friend','tiktok.com':'TikTok',
        'studentluxe.co.uk':'Unknown'
      };
      return domainMap[host] || 'Unknown';
    } catch(e) { return 'Unknown'; }
  }

  // Resolve the social channel by signal strength:
  // utm_source (explicit, set by us) > referrer host > Instagram default.
  // fbclid is auto-injected on any IG/FB outbound link, not just ads —
  // we don't run Meta ads, so the safe default is organic Instagram.
  function resolveSocialChannel () {
    if (utmSource) return utmSourceToChannel(utmSource);
    const fromRef = extractChannel(p.referrer);
    if (fromRef && fromRef !== 'Unknown') return fromRef;
    return 'Instagram';
  }

  let leadSource  = '';
  let leadChannel = '';
  if (hasMsclkid)                       { leadSource = 'PPC';      leadChannel = 'Bing Advert'; }
  else if (isBingOrg || visitedHasBing) { leadSource = 'SEO';      leadChannel = 'Bing'; }
  else if (hasPpcSignal)                { leadSource = 'PPC';      leadChannel = 'Google Advert'; }
  else if (hasFbclid)                   { leadSource = 'Socials';  leadChannel = resolveSocialChannel(); }
  else if (isUtmSocial)                 { leadSource = 'Socials';  leadChannel = utmSourceToChannel(utmSource); }
  else if (isDirect)                    { leadSource = 'Referral'; leadChannel = 'Direct'; }
  else if (isGoogleOrg)                 { leadSource = 'SEO';      leadChannel = 'Google Search (organic)'; }
  else if (hasVisited)                  { leadSource = 'SEO';      leadChannel = extractChannel(p.referrer); }

  return { leadSource, leadChannel };
}

// ──────────────────────────────────────────────────────────────
//  MONDAY
// ──────────────────────────────────────────────────────────────
function currencyForCity(city, otherCity) {
  const GBP = ['london','edinburgh','glasgow','manchester','cambridge','durham','bristol','birmingham','brighton','liverpool','nottingham'];
  const EUR = ['dublin','paris','milan','amsterdam','rome','florence','helsinki','barcelona','madrid','lisbon','porto','valencia'];
  const USD = ['new-york','boston','chicago','washington','philadelphia'];
  const c = (city || '').toLowerCase().trim();
  if (GBP.includes(c)) return '£';
  if (EUR.includes(c)) return '€';
  if (USD.includes(c)) return '$';
  if (c === 'other' && otherCity) {
    const o = otherCity.toLowerCase();
    const currencyKeywords = {
      '£':['uk','united kingdom','england','scotland','wales','london','manchester','birmingham','edinburgh'],
      '€':['france','paris','germany','berlin','spain','madrid','barcelona','italy','rome','milan','netherlands','amsterdam','portugal','lisbon'],
      '$':['usa','united states','america','new york','los angeles','chicago','boston','washington'],
    };
    for (const [symbol, keywords] of Object.entries(currencyKeywords)) {
      if (keywords.some(k => o.includes(k))) return symbol;
    }
  }
  return '';
}

const CAMPAIGN_MAP = {
  '23593406109':'jf17_search_generic_os_tablet_phrase_in_row_destination_london','23676288424':'jf14_search_generic_os_tablet_broad_in_us_destination_london - £150 tCPA Test','23671659281':'jf3_search_generic_os_desktop_broad_in_us_destination_london - £150 tCPA Test','23598174873':'jf19_search_brand_global_exact','21918787893':'rentals-short-stay-os','23512016561':'cambridge-os','20356089756':'london-student-os','23603515408':'jf10_search_generic_os_mobile_exact_in_us_destination_london','23593407051':'jf9_search_generic_os_mobile_exact_in_row_destination_london','22561087901':'core-luxe-perf-max','23392672745':'new-york-os','21429830124':'lse-summer-uni-campus','23676301570':'jf9_search_generic_os_mobile_exact_in_row_destination_london - £150 tCPA Test','21973944922':'core-luxe-os','23671673024':'jf4_search_generic_os_desktop_exact_in_row_destination_london - £150 tCPA Test','23593406838':'jf12_search_generic_os_mobile_phrase_in_us_destination_london','23666278518':'jf13_search_generic_os_tablet_broad_in_row_destination_london - £150 tCPA Test','21902352633':'lse-summer-all-us','21499603565':'paris-os','23676319627':'jf15_search_generic_os_tablet_exact_in_row_destination_london - £150 tCPA Test','23593627429':'jf16_search_generic_os_tablet_exact_in_us_destination_london','23452513132':'lse-summer-perf-max','23642461894':'paris-os-exp','23666244384':'jf8_search_generic_os_mobile_broad_in_us_destination_london - £150 tCPA Test','23666254497':'jf5_search_generic_os_desktop_exact_in_us_destination_london - £150 tCPA Test','22082273952':'rentals-os','22120262100':'hnwi-pb-zip-os','23588980553':'jf3_search_generic_os_desktop_broad_in_us_destination_london','23671661003':'jf6_search_generic_os_desktop_phrase_in_us_destination_london - £150 tCPA Test','23593627561':'jf18_search_generic_os_tablet_phrase_in_us_destination_london','23676326599':'jf17_search_generic_os_tablet_phrase_in_row_destination_london - £150 tCPA Test','23588981654':'jf14_search_generic_os_tablet_broad_in_us_destination_london','23671688303':'jf18_search_generic_os_tablet_phrase_in_us_destination_london - £150 tCPA Test','23666271564':'jf10_search_generic_os_mobile_exact_in_us_destination_london - £150 tCPA Test','23593406301':'jf7_search_generic_os_mobile_broad_in_row_destination_london','23598893477':'jf2_search_generic_os_desktop_broad_in_row_destination_london','23676311422':'jf2_search_generic_os_desktop_broad_in_row_destination_london - £150 tCPA Test','23666273505':'jf12_search_generic_os_mobile_phrase_in_us_destination_london - £150 tCPA Test','23666255946':'jf11_search_generic_os_mobile_phrase_in_row_destination_london - £150 tCPA Test','23603514478':'jf13_search_generic_os_tablet_broad_in_row_destination_london','23598893927':'jf11_search_generic_os_mobile_phrase_in_row_destination_london','23598893684':'jf1_search_generic_os_desktop_phrase_in_row_destination_london','23642456119':'lse-summer-all-us-exp','23593406142':'jf15_search_generic_os_tablet_exact_in_row_destination_london','23671689740':'jf16_search_generic_os_tablet_exact_in_us_destination_london - £150 tCPA Test','23593406559':'jf8_search_generic_os_mobile_broad_in_us_destination_london',
};

function resolveCampaign(val) {
  if (!val) return '';
  const trimmed = val.trim();
  return /^\d+$/.test(trimmed) ? (CAMPAIGN_MAP[trimmed] || trimmed) : trimmed;
}

function extractCampaignFromPaths(visitedPaths) {
  if (!visitedPaths) return '';
  try {
    const segments = visitedPaths.split('👉');
    for (const seg of segments) {
      const match = seg.match(/utm_campaign=([^&\s]+)/);
      if (match && match[1]) return match[1].trim();
    }
  } catch(e) {}
  return '';
}

function bestCampaign(p) {
  const fromCookie = (p.utm_campaign || '').trim();
  const fromPaths  = extractCampaignFromPaths(p.visited_paths);
  if (fromCookie) {
    const resolved = resolveCampaign(fromCookie);
    if (!/^\d+$/.test(fromCookie) || CAMPAIGN_MAP[fromCookie]) return resolved;
  }
  if (fromPaths) return resolveCampaign(fromPaths);
  return resolveCampaign(fromCookie);
}

async function pushToMonday(p, submitterIp, duplicateOf) {
  const nameParts = (p.full_name || '').trim().split(' ');
  const firstname = nameParts[0] || '';
  const lastname  = nameParts.slice(1).join(' ') || '';
  let   itemName  = p.full_name || 'New Enquiry';

  // If the original lead's assignees are all deactivated, flag it in the item
  // name so the team knows to manually reassign on the Leads board.
  if (duplicateOf?.removedAssignees?.length > 0) {
    const names = duplicateOf.removedAssignees;
    const suffix = names.length === 1
      ? `(previously ${names[0]}'s lead)`
      : `(previously assigned to ${names.join(', ')})`;
    itemName = `${itemName} ${suffix}`;
  }

  const { leadSource, leadChannel } = computeLeadSource(p);

  const columnValues = {
    text37:           firstname,
    text60:           lastname,
    email:            p.email ? { email: p.email, text: p.email } : {},
    phone_1: p.phone ? (function(){
      const raw = p.phone.replace(/[\s\-().]/g, '');
      const dialMap = {'+44':'GB','+1':'US','+33':'FR','+49':'DE','+39':'IT','+34':'ES','+351':'PT','+31':'NL','+32':'BE','+41':'CH','+43':'AT','+46':'SE','+47':'NO','+45':'DK','+358':'FI','+48':'PL','+420':'CZ','+36':'HU','+40':'RO','+380':'UA','+7':'RU','+86':'CN','+81':'JP','+82':'KR','+91':'IN','+61':'AU','+64':'NZ','+27':'ZA','+55':'BR','+52':'MX','+971':'AE','+966':'SA','+974':'QA','+852':'HK','+65':'SG','+60':'MY','+66':'TH','+62':'ID'};
      let countryShortName = 'GB';
      for (const [prefix, code] of Object.entries(dialMap)) {
        if (raw.startsWith(prefix)) { countryShortName = code; break; }
      }
      return { phone: raw, countryShortName };
    })() : {},
    date47:            p.check_in  ? { date: p.check_in  } : {},
    date_1:            p.check_out ? { date: p.check_out } : {},
    budget_per_week:   p.budget ? formatBudget(p.budget, p) : '',
    text8:             p.city === 'other' ? (p.other_city || '') : (formatCity(p.city) || ''),
    dropdown6:         p.apartment_ref     || '',
    apt_type_mkmn4bgg: formatAptType(p.apartment_type) || '',
    dropdown19:        p.areas || '',
    dropdown40: p.response_methods ? {
      labels: p.response_methods.split(',').map(s => {
        const v = s.trim().toLowerCase();
        if(v === 'phone')    return 'Phone Call (preferred option)';
        if(v === 'whatsapp') return 'WhatsApp (preferred option)';
        if(v === 'email')    return 'Email';
        return s.trim();
      })
    } : {},
    color_mktcnwyb: p.stay_type ? { label: {
      'student':'Student','parent':'Parent or guardian (on behalf of student)',
      'working-professional':'Working professional','corporate':'Corporate',
      'medical':'Medical','tourism':'Tourism','agent':'Agent (on behalf of client)'
    }[p.stay_type] || p.stay_type } : {},
    // Partner portals only ever serve one institution, so the partner name is
    // authoritative here and the form's own university field is a fallback.
    text_mknfnmsb: partnerPortal(p)?.channel || p.university || '',
    text_mm5asah0: p.course      || '',
    text9__1:      p.nationality || '',
    long_text7:    p.message     || '',
    text_mm1c3b5w: bestCampaign(p),
    text43__1:     p.utm_adgroup   || '',
    text3__1:      p.utm_term      || '',
    text_mm1d87rp: p.utm_matchtype || '',
    // Prefer the FIRST-touch gclid (the click that originally acquired this
    // lead) over the current session's. A returning enquirer re-clicks a
    // different keyword/ad; the later Step 3/4 conversions should credit the
    // campaign that actually won them, not the re-click. Step 1 above still
    // uses the current-session gclid (that click drove this enquiry). Falls
    // back to the current click id when there is no first-touch gclid.
    text4__1:      p.first_gclid || p.gclid || p.gbraid || p.wbraid || p.fbclid || '',
    text_mm1jhhe7: p.landing_page  || '',
    long_text__1:  p.visited_paths || '',
    text_mm2y2ah2: submitterIp     || '',
    // Attribution columns (added 2026-06-25)
    text_mm4n6987: p.device     || '',                                                       // device
    text_mm4n61bc: p.country    || '',                                                       // country
    text_mm4nkhk0: p.first_touch ? classifyTouch(p.first_touch) : '',                        // first_channel
    text_mm4ntp4n: (p.first_touch && p.first_touch.campaign) || p.first_campaign || '',      // first_campaign
    text_mm4ncd41: p.gbraid     || '',                                                       // gbraid
    text_mm4n9t2x: p.wbraid     || '',                                                       // wbraid
    text_mm4n9415: p.session_id || '',                                                       // session_id
    ...(duplicateOf && { color_mknqvzde: { label: 'Possible Duplicate' } }),
    ...(duplicateOf?.assigneeIds?.length > 0 && {
      people_1: { personsAndTeams: duplicateOf.assigneeIds.map(id => ({ id, kind: 'person' })) }
    }),
    ...(leadSource  && { color_mkxk8y67: { label: leadSource } }),
    ...(leadChannel && leadChannel !== 'Unknown' && { dropdown_mkxkfbff: { labels: [leadChannel] } }),
    dropdown_mm1v31yb: { labels: [partnerPortal(p)?.formName || '/Reservations Form'] },
    ...(p.city && currencyForCity(p.city, p.other_city) && { status0__1: { label: currencyForCity(p.city, p.other_city) } }),
  };

  const mutation = `
    mutation {
      create_item(
        board_id: ${MONDAY_BOARD},
        item_name: ${JSON.stringify(itemName)},
        column_values: ${JSON.stringify(JSON.stringify(columnValues))}
      ) { id }
    }
  `;

  // Retry the create: Monday intermittently returns
  // API_TEMPORARILY_BLOCKED / rate-limit errors that clear within
  // seconds. Losing the CRM write over a transient block costs a lead.
  const RETRY_DELAYS = [2000, 5000, 10000];
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const response = await fetch(MONDAY_API, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
        body: JSON.stringify({ query: mutation })
      });

      const text = await response.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error('Monday non-JSON (HTTP ' + response.status + '): ' + text.slice(0, 120)); }

      if (!response.ok) throw new Error('Monday HTTP ' + response.status);
      if (data.errors) {
        console.error('Monday API errors:', JSON.stringify(data.errors, null, 2));
        throw new Error('Monday API error: ' + JSON.stringify(data.errors));
      }
      return data?.data?.create_item?.id;
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || '');
      const transient = /API_TEMPORARILY_BLOCKED|RATE_LIMIT|COMPLEXITY|non-JSON|HTTP 5\d\d|HTTP 429/i.test(msg);
      if (!transient || attempt === RETRY_DELAYS.length) throw err;
      console.warn(`Monday create attempt ${attempt + 1} failed (transient), retrying in ${RETRY_DELAYS[attempt]}ms:`, msg.slice(0, 150));
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
  throw lastErr;
}

// ──────────────────────────────────────────────────────────────
//  RESEND
// ──────────────────────────────────────────────────────────────
async function resendSend(payload) {
  const res = await fetch(RESEND_API, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Resend error ${res.status}: ${err}`); }
  return res.json();
}

// ──────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); } catch { return d; }
}
function nights(p) {
  if (!p.check_in || !p.check_out) return null;
  const n = Math.round((new Date(p.check_out) - new Date(p.check_in)) / 86400000);
  return n > 0 ? n : null;
}
function formatCity(city) {
  if (!city) return '';
  const map = {'london':'London','new-york':'New York','paris':'Paris','edinburgh':'Edinburgh','glasgow':'Glasgow','manchester':'Manchester','cambridge':'Cambridge','durham':'Durham','bristol':'Bristol','barcelona':'Barcelona','madrid':'Madrid','lisbon':'Lisbon','boston':'Boston','chicago':'Chicago','washington':'Washington DC','amsterdam':'Amsterdam','milan':'Milan','rome':'Rome','florence':'Florence','helsinki':'Helsinki','porto':'Porto','valencia':'Valencia','birmingham':'Birmingham','brighton':'Brighton','liverpool':'Liverpool','nottingham':'Nottingham','dublin':'Dublin','philadelphia':'Philadelphia'};
  return map[city] || city;
}
function formatAptType(t) {
  if (!t) return '';
  const map = {'studio':'Studio','1bed':'1 bedroom','2bed':'2 bedroom','3bed':'3 bedroom','penthouse':'Penthouse','flexible':'Flexible',
    // Partner portals ask for a living category rather than a unit size.
    'shared':'Shared student living','private':'Private rooms & studios','serviced':'Luxury serviced apartments'};
  return map[t] || t;
}
// Area selects post slugs ('city-clerkenwell'), so anything guest-facing needs
// this or it reads like a URL. Unknown slugs title-case rather than fall
// through raw.
function formatArea(a) {
  if (!a) return '';
  const map = {
    'city-clerkenwell':   'The City & Clerkenwell',
    'kensington-chelsea': 'Kensington & Chelsea',
    'soho-covent-garden': 'Soho & Covent Garden',
  };
  if (map[a]) return map[a];
  return String(a).split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function formatBudget(b, p) {
  if (!b) return '';
  const map = {'under-650':'Under £650','650-1000':'£650 – £1,000','1000-2000':'£1,000 – £2,000','2000-4000':'£2,000 – £4,000','5000+':'£5,000+','under-550':'Under £550','550-900':'£550 – £900','900-1350':'£900 – £1,350','1350-2000':'£1,350 – £2,000','2000+':'£2,000+','850-1200':'£850 – £1,200','1200-2000':'£1,200 – £2,000','2000-3500':'£2,000 – £3,500','3500-5000':'£3,500 – £5,000','under-1250':'Under £1,250','1250-1800':'£1,250 – £1,800','1800-2500':'£1,800 – £2,500','2500-4000':'£2,500 – £4,000',
    // Marangoni portal. NOTE: its option values are stale against the labels
    // the guest actually sees (value "350-500" is shown as "£350 – £650"), so
    // these map to the shown label, not the value. '350-650'/'650-1000' are
    // here too so nothing breaks if the form values are ever corrected.
    '350-500':'£350 – £650','350-650':'£350 – £650','500-1000':'£650 – £1,000','1000-plus':'£1,000+'};
  if (map[b]) return map[b];

  // Anything not spelled out above is parsed generically rather than dumped
  // raw into Monday. The currency comes from the enquiry's city: '5000-10000'
  // is £ from the London forms but € from the worldwide one, so a fixed
  // symbol would mislabel half of them.
  const sym = (p && currencyForCity(p.city, p.other_city)) || '£';
  const n   = s => Number(s).toLocaleString('en-GB');
  let m;
  if ((m = /^under-(\d+)$/.exec(b)))       return `Under ${sym}${n(m[1])}`;
  if ((m = /^(\d+)-(\d+)$/.exec(b)))       return `${sym}${n(m[1])} – ${sym}${n(m[2])}`;
  if ((m = /^(\d+)(?:\+|-plus)$/.exec(b))) return `${sym}${n(m[1])}+`;
  return b;
}
function formatStayType(type, university) {
  if (!type) return '';
  const map = {'student':'Student','parent':'Parent or guardian (on behalf of student)','working-professional':'Working professional','corporate':'Corporate','medical':'Medical','tourism':'Tourism','agent':'Agent (on behalf of client)'};
  const label = map[type] || type;
  return university ? `${label} · ${university}` : label;
}
