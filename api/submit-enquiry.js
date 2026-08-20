// ============================================================
//  Student Luxe — Enquiry Submit + Email Handler
//  Deploy to: /api/submit-enquiry.js in your Vercel project
// ============================================================

const RESEND_API   = 'https://api.resend.com/emails';
const MONDAY_API   = 'https://api.monday.com/v2';
const MONDAY_BOARD = 2171015719;

const { buildTouch, getSession, attachSubmission, classifyTouch, countryName } = require('./_attribution.js');
const { recordOptOut } = require('./_audience.js');
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
    // Clean txn fallback for no-session leads: raw email in a transaction id
    // now 400s at Google (rejected since ~27 Jul 2026).
    p.monday_id = mondayId;
    const dmResult = await uploadGoogleAdsConversion(p);
    console.log('Google Ads conversion uploaded OK');
    await logGadsEvent({ ...gadsCtx, ok: true });
  } catch(err) {
    console.error('Google Ads conversion failed (non-fatal):', err.message);
    // Log only. Alerting is owned by /api/replay-failed-events, which emails
    // once a fail has not self-healed after STUCK_MS.
    await logGadsEvent({ ...gadsCtx, ok: false, error: err.message });
  }

  // Marketing opt-out: remember it (hashed) so the Customer Match list never
  // includes this guest, even via the nightly sweep.
  if (p.marketing_opt_in === false && p.email) {
    await recordOptOut(p.email);
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
    transactionId:         String(p.session_id || p.monday_id || Date.now()),
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

  // Weekend (Sat=6, Sun=0) or Friday after 5pm
  const isFriAfter6  = dayOfWeek === 5 && minuteOfDay >= 17 * 60;
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
    !isTypeA && p.budget       && ['Budget per ' + budgetPeriod(p.city), formatBudget(p.budget, p)],
    p.check_in                 && ['Check-in',             formatDate(p.check_in)],
    p.check_out                && ['Check-out',            formatDate(p.check_out)],
    nights(p)                  && ['Stay length',          nights(p) + ' nights'],
    !isTypeA && p.areas        && ['Areas of interest',    formatArea(p.areas)],
    p.response_methods         && ["We\u2019ll respond via", formatResponseMethods(p.response_methods)],
  ].filter(Boolean);

  // Greeting body copy — adapts per enquiry type and response state
  // "A member of our Reservations team..." removed — covered by Expected Response Time section
  const bodyTypeA = isTypeA
    ? `Thank you for your enquiry about <strong>${escHtml(p.apartment_ref || 'your chosen apartment')}</strong> \u2014 we\u2019re checking the latest availability and pricing for your chosen dates.`
    : `Thank you for your <strong>${escHtml(formatCity(p.city) || '')}</strong> apartment enquiry \u2014 we\u2019re curating the best available options for your dates and budget.`;

  const HEADER_BG = 'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/dc5adc8f-739b-4db0-8698-c08a6e6b85d3/luxury-student-apartments.jpg?content-type=image%2Fjpeg';
  const FOOTER_BG = EMAIL_IMG.footer;
  const tick = text => `
            <td width="50%" class="sl-tick" style="padding:4px 0;font-size:12px;color:#1a1a1a;vertical-align:middle;">
              <span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:14px;font-size:8px;color:#B8966E;margin-right:7px;vertical-align:middle;">&#10003;</span>${text}</td>`;
  const LOGO_WHITE = 'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/b4112f3c-4153-4544-b7bd-2c93282a68a2/Logo+White+website.png?content-type=image%2Fpng';

  const _submittedDate = new Date(p.submitted_at || Date.now()).toLocaleString('en-GB',{day:'numeric',month:'long',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true,timeZone:'Europe/London'});
  // Format: "21 May 2026, 4:57 pm" → "on 21 May 2026 at 4:57 pm"
  // Node 20+ ICU renders "21 May 2026 at 4:57 pm" instead of using a comma, so
  // the optional "at" is swallowed here rather than doubled up in the output.
  const _dateParts = _submittedDate.match(/^(\d+ \w+ \d+),?\s+(?:at\s+)?(.+)$/);
  const _dateFormatted = _dateParts ? `on ${_dateParts[1]} at ${_dateParts[2]}` : _submittedDate;

  // Cells match the team notification, so both sides of an enquiry read the
  // same. Two per row, stacked into pairs from whatever we actually hold.
  const cell = (label, value) => `
            <td class="sl-half" width="50%" style="vertical-align:top;padding:0 10px 15px 0;">
              <p style="margin:0 0 3px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:#9b9b9b;">${label}</p>
              <p style="margin:0;font-size:12.5px;font-weight:500;color:#1a1a1a;word-break:break-word;">${escHtml(String(value))}</p>
            </td>`;
  const summaryRows = rows.reduce((acc, _, i) => {
    if (i % 2) return acc;
    const right = rows[i + 1] ? cell(rows[i + 1][0], rows[i + 1][1]) : '<td class="sl-half" width="50%"></td>';
    return acc + `<tr>${cell(rows[i][0], rows[i][1])}${right}</tr>`;
  }, '');

  // Weekend and bank holiday enquiries get a strip under the header, so nobody
  // waits by the phone on a Saturday. Everything else stays quiet.
  const backOn = String(status.heading || '').replace(/^From /, '');
  const closedBanner = (status.state === 'weekend' || status.state === 'holiday') ? `
  <tr><td class="sl-pad" style="background:#FBF8F2;border-top:2px solid #B8966E;border-bottom:1px solid rgba(184,150,110,0.35);padding:12px 32px;text-align:center;">
    <p style="margin:0;font-size:12.5px;color:#8B6E4E;line-height:1.5;">${status.state === 'weekend'
      ? `<span style="font-weight:500;">Office closed for the weekend.</span> We&rsquo;ll respond first thing Monday.`
      : `<span style="font-weight:500;">Our office is closed.</span> We&rsquo;ll respond as soon as we are back on ${escHtml(backOn)}.`}</p>
  </td></tr>` : '';

  // The bold promise at the end of the intro tracks the same status, so it
  // never promises 24 hours on a Sunday.
  const replyPromise = status.state === 'weekend'
    ? 'first thing on Monday morning.'
    : status.state === 'holiday'
    ? `as soon as we are back on ${escHtml(backOn)}.`
    : 'within the next 24 hours, or within 1 business day.';

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your enquiry with Student Luxe</title>
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  :root{color-scheme:light dark;supported-color-schemes:light dark}
  /* The wordmark is white artwork on transparency, so its bands stay dark in
     every scheme. */
  .sl-dark{background-color:#000000!important}
  .sl-on-dark{color:#ffffff!important}
  .sl-on-dark-gold{color:#D4B896!important}
  @media (prefers-color-scheme:dark){
    .sl-dark{background-color:#000000!important}
    .sl-on-dark{color:#ffffff!important}
    .sl-on-dark-gold{color:#D4B896!important}
  }
  @media only screen and (max-width:600px){
    .sl-outer-wrap { padding:0 !important; }
    .sl-card { border-radius:0 !important; border-left:none !important; border-right:none !important; }
    .sl-pad { padding-left:14px !important; padding-right:14px !important; }
    .sl-cardpad { padding:14px 14px !important; }
    .sl-tick { display:block !important; width:100% !important; }
    .sl-hd-logo { height:19px !important; }
    .sl-foot-links { line-height:2.4 !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#EDE9E1;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" class="sl-outer-wrap" style="background:#EDE9E1;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" class="sl-card" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:0.5px solid rgba(0,0,0,0.15);">

  <!-- HEADER: centred band over an apartment photo with a black wash. Outlook
       drops the photo and keeps the bgcolor. -->
  <tr><td class="sl-pad sl-dark" bgcolor="#000000" background="${HEADER_BG}" style="background-color:#000000;background-image:linear-gradient(rgba(0,0,0,0.65),rgba(0,0,0,0.65)),url('${HEADER_BG}');background-size:cover;background-position:center;background-repeat:no-repeat;padding:26px 32px 24px;text-align:center;">
    <img class="sl-hd-logo" src="${LOGO_WHITE}" alt="Student Luxe" height="22" style="height:22px;width:auto;display:block;margin:0 auto 20px;">
    <p class="sl-on-dark-gold" style="margin:0 0 6px;font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:#D4B896;">Thank you</p>
    <p class="sl-on-dark" style="margin:0 0 6px;font-family:Georgia,serif;font-size:24px;color:#ffffff;letter-spacing:-0.035em;line-height:1.25;">We&rsquo;ve received your enquiry.</p>
    <p class="sl-on-dark" style="margin:0;font-size:11.5px;color:rgba(255,255,255,0.6);">Sent ${_dateFormatted}</p>
  </td></tr>
${closedBanner}
  <!-- INTRO -->
  <tr><td class="sl-pad" style="padding:28px 32px 0;">
    <p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:#1a1a1a;">Dear ${escHtml(firstName)},</p>
    <p style="margin:0 0 22px;font-size:14px;line-height:1.75;color:#3c3c3c;">${isTypeA
      ? `Thank you for your enquiry about <strong>${escHtml(p.apartment_ref || 'your chosen apartment')}</strong>. We are checking the latest availability and pricing for your dates`
      : `Thank you for your <strong>${escHtml(formatCity(p.city) || '')}</strong> apartment enquiry. We are curating the best available options for your dates and budget`}, and one of our advisors will be in touch on your preferred channel <strong>${replyPromise}</strong></p>

    <!-- WHAT HAPPENS NEXT -->
    <p style="margin:0 0 12px;font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:#8B6E4E;">What happens next</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F2;border-radius:10px;"><tr><td class="sl-cardpad" style="padding:18px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td width="34" style="vertical-align:top;font-family:Georgia,serif;font-size:15px;color:#B8966E;padding-bottom:14px;">01)</td>
            <td style="padding-bottom:14px;"><p style="margin:0 0 2px;font-size:13.5px;font-weight:500;color:#1a1a1a;">We&rsquo;ll be in touch shortly</p><p style="margin:0;font-size:12.5px;color:#6b6b6b;line-height:1.55;">Your dedicated advisor will contact you on your preferred channel to share our latest availability and apartment options. Any questions, they&rsquo;re your point of contact throughout.</p></td></tr>
        <tr><td width="34" style="vertical-align:top;font-family:Georgia,serif;font-size:15px;color:#B8966E;padding-bottom:14px;">02)</td>
            <td style="padding-bottom:14px;"><p style="margin:0 0 2px;font-size:13.5px;font-weight:500;color:#1a1a1a;">View your favourites</p><p style="margin:0;font-size:12.5px;color:#6b6b6b;line-height:1.55;">In-person and virtual viewings available, arranged around your schedule.</p></td></tr>
        <tr><td width="34" style="vertical-align:top;font-family:Georgia,serif;font-size:15px;color:#B8966E;">03)</td>
            <td><p style="margin:0 0 2px;font-size:13.5px;font-weight:500;color:#1a1a1a;">Book and move in</p><p style="margin:0;font-size:12.5px;color:#6b6b6b;line-height:1.55;">Our simple booking process secures your apartment quickly, so all that&rsquo;s left is to settle in and enjoy your new home.</p></td></tr>
      </table>
    </td></tr></table>
  </td></tr>

  <!-- WHAT YOU TOLD US -->
  <tr><td class="sl-pad" style="padding:24px 32px 0;">
    <p style="margin:0 0 12px;font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:#8B6E4E;">What you&rsquo;ve told us so far</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(184,150,110,0.35);border-radius:10px;"><tr><td class="sl-cardpad" style="padding:18px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0">${summaryRows}</table>
    </td></tr></table>

    ${p.message ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 0;"><tr>
      <td style="background:#FBF8F2;border-left:3px solid #B8966E;border-radius:0 8px 8px 0;padding:14px 16px;">
        <p style="margin:0 0 4px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:#8B6E4E;">Your message</p>
        <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.7;font-style:italic;">&ldquo;${escHtml(p.message)}&rdquo;</p>
      </td>
    </tr></table>` : ''}
  </td></tr>

  <!-- ABOUT -->
  <tr><td class="sl-pad" style="padding:24px 32px 0;">
    <p style="margin:0 0 12px;font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:#8B6E4E;">About Student Luxe</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F2;border-radius:10px;"><tr><td class="sl-cardpad" style="padding:18px 20px;">
      <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:16px;color:#1a1a1a;letter-spacing:-0.01em;">Simply unpack and <em style="color:#B8966E;">start living.</em></p>
      <p style="margin:0 0 16px;font-size:12.5px;color:#6b6b6b;line-height:1.6;">All of our professionally-managed apartments are private, furnished, set up and ready to move in. All bills, Wi-Fi, housekeeping and resident support are included as standard. No guarantors or credit checks required.</p>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>${tick('Fully furnished &amp; equipped')}${tick('Weekly housekeeping')}</tr>
        <tr>${tick('All bills &amp; everything included')}${tick('Flexible lengths of stay')}</tr>
        <tr>${tick('Hotel-style amenities')}${tick('Ongoing resident support')}</tr>
      </table>
    </td></tr></table>
    <p style="margin:18px 0 28px;font-size:12.5px;color:#9b9b9b;">Anything to change? Just reply to this email and we will update it.</p>
  </td></tr>

  <!-- FOOTER -->
  <tr><td class="sl-pad sl-dark" bgcolor="#000000" background="${FOOTER_BG}" style="background-color:#000000;background-image:linear-gradient(rgba(0,0,0,0.8),rgba(0,0,0,0.8)),url('${FOOTER_BG}');background-size:cover;background-position:center;background-repeat:no-repeat;padding:30px 32px;">
    <img src="${LOGO_WHITE}" alt="Student Luxe" height="21" style="height:21px;width:auto;display:block;margin:0 auto 18px;">
    <p class="sl-on-dark" style="margin:0 0 8px;text-align:center;font-family:Georgia,serif;font-size:15px;color:#ffffff;letter-spacing:-0.01em;">Luxury student and serviced apartments</p>
    <p style="margin:0 0 16px;text-align:center;font-size:12px;line-height:1.7;color:rgba(255,255,255,0.6);">Dog &amp; Duck Yard, Princeton St, London WC1R 4BH<br>+44 (0)203 007 0017 &middot; Mon to Fri, 10am to 6pm</p>
    <p class="sl-foot-links" style="margin:0;text-align:center;font-size:12px;line-height:2;"><a href="${siteUrl}/services" style="color:#D4B896;text-decoration:none;">What&rsquo;s included</a> &nbsp;&middot;&nbsp; <a href="${siteUrl}/our-reviews" style="color:#D4B896;text-decoration:none;">Reviews</a> &nbsp;&middot;&nbsp; <a href="${siteUrl}/faqs" style="color:#D4B896;text-decoration:none;">FAQs</a> &nbsp;&middot;&nbsp; <a href="${siteUrl}/meet-the-team" style="color:#D4B896;text-decoration:none;">Meet the team</a></p>
    <p style="margin:16px 0 0;text-align:center;font-size:10.5px;color:rgba(255,255,255,0.35);">&copy; ${new Date().getFullYear()} Student Luxe Apartments &middot; If you did not submit this enquiry, please disregard.</p>
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
// Hosted artwork for the redesigned emails. Both logos are white on
// transparency, so every band they sit on has to stay dark. The photos are
// laid under a black gradient wash; Outlook drops the image and keeps the
// bgcolor, which is why each band carries both.
const EMAIL_IMG = {
  seal:     'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/83bf050f-4124-4da2-8fec-073287bd8495/seal-wordmark-ivory-on-transparent-2.png?content-type=image%2Fpng',
  wordmark: 'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/3b2d0218-5cf8-4041-8460-2ec2228c864b/Logo+White+website.png?content-type=image%2Fpng',
  school:   'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/60fe613f-b4ce-4e6e-bd0c-ef94e187ddf9/istituto-marangoni-png.png?content-type=image%2Fpng',
  // Squarer lockup, used where the mark sits small in a condensed band.
  schoolAlt:'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/d2ee5c81-8e9f-4ebd-a142-4234962fde80/istituto-marangoni-london-logo-1.png?content-type=image%2Fpng',
  hero:     'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/860cc079-de7e-42c8-835a-d5ff12c84f34/marangoni-2.jpg?content-type=image%2Fjpeg',
  footer:   'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/1709156541414-LL1XG1IVRXX4IXKZWPHR/12.+3++Bed+Westminster+Amphora+Apartments+Bed.jpg?content-type=image%2Fjpeg',
  paige:    'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/54094f14-2f02-479b-b1ba-5e01bbab2afd/Paige-student-luxe-1.jpg',
  page:     'https://www.studentluxe.co.uk/istituto-marangoni-london-accommodation',
};

async function sendPartnerGuestConfirmation(p, portal) {
  if (!p.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) {
    console.warn('Partner guest confirmation skipped — invalid email:', p.email);
    return;
  }

  const firstName  = (p.full_name || '').split(' ')[0] || 'there';
  const nightCount = nights(p);
  // Standard student living and Not sure yet are auto-assigned to a named
  // owner, so those guests get her name and sign-off. Everything else stays
  // with the Reservations team and reads as "a Student Luxe advisor".
  const isPaige    = !!routedAssigneeId(p);
  const building   = (p.building || '').trim();

  // Each cell renders only when we actually hold the value, so a sparse
  // enquiry produces a tidy card rather than a grid of dashes.
  const cell = (label, value, accent) => value ? `
            <td class="sl-half" width="50%" style="vertical-align:top;padding-bottom:15px;">
              <p style="margin:0 0 3px;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#9b9b9b;">${label}</p>
              <p style="margin:0;font-size:13.5px;font-weight:500;color:${accent ? '#B8966E' : '#1a1a1a'};">${escHtml(String(value))}</p>
            </td>` : '<td class="sl-half" width="50%"></td>';

  const step = (n, title, body, last) => `
        <tr><td width="34" style="vertical-align:top;font-family:Georgia,serif;font-size:15px;color:#B8966E;${last ? '' : 'padding-bottom:14px;'}">${n})</td>
            <td${last ? '' : ' style="padding-bottom:14px;"'}><p style="margin:0 0 2px;font-size:13.5px;font-weight:500;color:#1a1a1a;">${title}</p><p style="margin:0;font-size:12.5px;color:#6b6b6b;line-height:1.55;">${body}</p></td></tr>`;

  const steps = isPaige
    ? step('01', 'Paige from Student Luxe will contact you', 'On your preferred channel, to talk through areas, budget and dates')
    + step('02', 'Receive your shortlist', 'A hand-picked selection matched to your preferences and budget, with our honest recommendation on which is right for you')
    + step('03', 'Book your home', 'Either with us, or with one of our partners, we&rsquo;ll ensure a seamless booking process so you can relax and enjoy your new home', true)
    : step('01', 'A Student Luxe advisor will contact you', 'On your preferred channel, to talk through areas, budget and dates')
    + step('02', 'We&rsquo;ll send you apartment options', 'Marangoni began with a tailor, and we take the same approach to finding your accommodation. Hand-picked, bespoke to your needs.')
    + step('03', 'Book, and move-in to your new home', 'Our simple booking process means you can relax and enjoy your new home quickly. Remember, all apartments are furnished, set up and ready to move in, with all bills included.', true);

  // Paige is named to the guest, so she gets a face. Team-owned enquiries get a
  // plain closing line instead.
  const closingSlot = isPaige ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 0;padding:22px 0 0;border-top:1px solid rgba(184,150,110,.3);"><tr><td>
      <table cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;padding-right:16px;width:62px;">
          <img src="${EMAIL_IMG.paige}" alt="Paige Grinter" width="62" height="62" style="width:62px;height:62px;display:block;border-radius:50%;object-fit:cover;">
        </td>
        <td style="vertical-align:middle;">
          <p style="margin:0 0 3px;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#9b8f7d;">Your point of contact</p>
          <p style="margin:0 0 2px;font-family:Georgia,serif;font-size:18px;color:#1a1a1a;">Paige Grinter</p>
          <p style="margin:0;font-size:12px;color:#9b8f7d;">Our accommodation advisor for ${escHtml(portal.school)}</p>
        </td>
      </tr></table>
      <p style="margin:14px 0 0;font-size:12.5px;line-height:1.6;color:#6b6b6b;">Any replies to this email go straight to Paige and the Student Luxe Reservations team.</p>
    </td></tr></table>`
    : `
    <p style="margin:0;font-size:12.5px;color:#9b9b9b;">Anything to change? Just reply to this email and we will update it.</p>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your accommodation enquiry, ${escHtml(portal.school)}</title>
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  :root{color-scheme:light dark;supported-color-schemes:light dark}
  /* The logos are white artwork on transparency, so the bands behind them must
     stay dark in every scheme. Declaring dark support stops iOS Mail inverting
     them; these rules cover the clients that invert anyway. */
  .sl-dark{background-color:#000000!important}
  .sl-on-dark{color:#ffffff!important}
  .sl-on-dark-gold{color:#D4B896!important}
  @media (prefers-color-scheme:dark){
    .sl-dark{background-color:#000000!important}
    .sl-on-dark{color:#ffffff!important}
    .sl-on-dark-gold{color:#D4B896!important}
  }
  @media (max-width:620px){
    .sl-pad{padding-left:22px!important;padding-right:22px!important}
    .sl-half{display:block!important;width:100%!important}
    .sl-foot-line{font-size:12.5px!important;line-height:1.4!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#EDE9E1;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#EDE9E1;padding:32px 16px;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:.5px solid rgba(0,0,0,.15);">

  <!-- HEADER: centred lockup. The rule sits on the header centre line, with
       each mark hugging it from its own half, so the wider logo cannot pull it
       off centre. Both marks are white artwork, so this band must stay dark.
       Outlook drops the photo and falls back to the bgcolor. -->
  <tr><td class="sl-pad sl-dark" bgcolor="#000000" background="${EMAIL_IMG.hero}" style="background-color:#000000;background-image:linear-gradient(rgba(0,0,0,.75),rgba(0,0,0,.75)),url('${EMAIL_IMG.hero}');background-size:cover;background-position:center;background-repeat:no-repeat;padding:30px 32px 26px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;"><tr>
      <td width="50%" align="right" style="vertical-align:middle;padding-right:24px;">
        <img src="${EMAIL_IMG.school}" alt="${escHtml(portal.school)}" height="84" style="height:84px;width:auto;display:block;margin-left:auto;">
      </td>
      <td width="1" style="width:1px;vertical-align:middle;padding:0;font-size:0;line-height:0;">
        <table cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="1" height="60" bgcolor="#4A4A4A" style="width:1px;height:60px;line-height:60px;font-size:0;background-color:#4A4A4A;">&nbsp;</td>
        </tr></table>
      </td>
      <td width="50%" align="left" style="vertical-align:middle;padding-left:24px;">
        <img src="${EMAIL_IMG.seal}" alt="Student Luxe" height="96" style="height:96px;width:auto;display:block;margin-right:auto;">
      </td>
    </tr></table>
    <p class="sl-on-dark" style="margin:24px 0 0;text-align:center;font-family:Georgia,serif;font-size:23.5px;color:#ffffff;letter-spacing:-.035em;line-height:1.25;">We&rsquo;ve received your accommodation enquiry.</p>
  </td></tr>

  <tr><td class="sl-pad" style="padding:28px 32px 0;">
    <p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:#1a1a1a;">Dear ${escHtml(firstName)},</p>
    <p style="margin:0 0 22px;font-size:14px;line-height:1.75;color:#3c3c3c;">Thank you for your enquiry with Student Luxe, the accommodation office for ${escHtml(portal.school)}. We will now put together a shortlist of options matched to your needs, budget and lifestyle.</p>

    <p style="margin:0 0 12px;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:#8B6E4E;">What happens next</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F2;border-radius:10px;"><tr><td style="padding:18px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0">
${steps}
      </table>
    </td></tr></table>

    <p style="margin:24px 0 12px;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:#8B6E4E;">Your enquiry</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(184,150,110,.35);border-radius:10px;"><tr><td style="padding:18px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>${cell('Accommodation type', formatAptType(p.apartment_type))}${cell('Building', building, true)}</tr>
        <tr>${cell('Guide price', p.budget ? formatBudget(p.budget, p) + ' /' + budgetPeriod(p.city) : '')}${cell('Staying', nightCount ? nightCount + ' nights' : '')}</tr>
        <tr>${cell('Check-in', formatDate(p.check_in))}${cell('Check-out', formatDate(p.check_out))}</tr>
        <tr>${cell('Preferred contact', formatResponseMethods(p.response_methods))}${cell('Preferred areas', formatArea(p.areas))}</tr>
      </table>
    </td></tr></table>

    ${p.message ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 0;"><tr>
      <td style="background:#FBF8F2;border-left:3px solid #B8966E;border-radius:0 8px 8px 0;padding:14px 16px;">
        <p style="margin:0 0 4px;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#8B6E4E;">Your message</p>
        <p style="margin:0;font-size:13px;color:#1a1a1a;line-height:1.7;font-style:italic;">&ldquo;${escHtml(p.message)}&rdquo;</p>
      </td>
    </tr></table>` : ''}

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 28px;"><tr><td>${closingSlot}</td></tr></table>
  </td></tr>

  <!-- FOOTER: seal, one line of who we are, then contact, over the same style
       of photo wash as the header. -->
  <tr><td class="sl-pad sl-dark" bgcolor="#000000" background="${EMAIL_IMG.footer}" style="background-color:#000000;background-image:linear-gradient(rgba(0,0,0,.8),rgba(0,0,0,.8)),url('${EMAIL_IMG.footer}');background-size:cover;background-position:center;background-repeat:no-repeat;padding:30px 32px;">
    <img src="${EMAIL_IMG.wordmark}" alt="Student Luxe" height="21" style="height:21px;width:auto;display:block;margin:0 auto 18px;">
    <p class="sl-on-dark sl-foot-line" style="margin:0 0 8px;text-align:center;font-family:Georgia,serif;font-size:15px;color:#ffffff;letter-spacing:-.01em;">The accommodation office for ${escHtml(portal.school)}</p>
    <p style="margin:0 0 16px;text-align:center;font-size:12px;line-height:1.7;color:rgba(255,255,255,.6);">Dog &amp; Duck Yard, Princeton St, London WC1R 4BH<br>+44 (0)203 007 0017 &middot; Mon to Fri, 10am to 6pm</p>
    <p style="margin:0;text-align:center;font-size:11.5px;"><a href="${EMAIL_IMG.page}" style="color:#D4B896;text-decoration:none;border-bottom:1px solid rgba(184,150,110,.45);">Back to the Accommodation Hub</a></p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  return resendSend({
    from:     `${portal.fromName} <${portal.fromEmail}>`,
    to:       [p.email],
    // Paige's enquiries reply to the partner alias, which she reads. Sales
    // enquiries reply straight into the Reservations inbox that works them.
    reply_to: isPaige ? portal.fromEmail : (process.env.TEAM_EMAIL || portal.fromEmail),
    subject:  `Your ${portal.school} accommodation enquiry`,
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

  // Whoever owns the lead this one duplicates. The header names them so the
  // team knows who to talk to before touching it.
  const originalOwner = (duplicateOf && duplicateOf.assignees && duplicateOf.assignees.length)
    ? duplicateOf.assignees.join(', ')
    : 'nobody yet';

  const quoteUrl = mondayId
    ? `https://luxe-quote-builder.vercel.app/?lead=${mondayId}`
    : `https://studentluxe.monday.com/boards/${MONDAY_BOARD}/views/205648977`;

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

  // Row WAS created, but Monday rejected specific column values (e.g. a
  // malformed email) and they were omitted from the row. Tell the team
  // exactly what is missing and what the guest actually typed.
  const omittedBanner = (!mondayError && p._omittedFields?.length) ? `
  <tr><td style="padding:0 28px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff3cd;border:1px solid #f0ad4e;border-radius:8px;">
      <tr><td style="padding:12px 16px;">
        <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#856404;">⚠️ Lead saved to Monday, but ${p._omittedFields.length === 1 ? 'one field was' : 'some fields were'} rejected and left blank — fix manually</p>
        ${p._omittedFields.map(f => `<p style="margin:0;font-size:11px;color:#856404;line-height:1.6;"><strong>${escHtml(f.label)}</strong>: guest entered <code style="font-size:10px;background:rgba(0,0,0,0.06);padding:1px 4px;border-radius:3px;">${escHtml(f.value || '(empty)')}</code></p>`).join('')}
        <p style="margin:4px 0 0;font-size:10px;color:#856404;">The rejected value is also saved in the row's notes field.</p>
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

    // Ownership card, same shape as the partner email's auto-assigned strip,
    // so both emails show "who has this" the same way.
    const owners   = (duplicateOf.assignees || []).filter(Boolean);
    const ownerName = owners.length ? owners.join(', ') : 'Nobody yet';
    const initials  = owners.length
      ? owners[0].split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
      : '?';

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
  <tr><td class="sl-pad" style="background:#ffffff;padding:20px 32px 0;">

    <p style="margin:0 0 4px;font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:#8B6E4E;">Original Lead vs. New Lead</p>
    <p style="margin:0 0 14px;font-size:12.5px;color:#6b6b6b;">${duplicateOf.matchCount} of 4 duplicate checking signals match.</p>
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
    <div style="height:14px;"></div>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F2;border-radius:10px;margin-bottom:20px;"><tr><td style="padding:14px 18px;">
      <table cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;padding-right:14px;width:42px;">
          <table cellpadding="0" cellspacing="0" style="width:42px;height:42px;border-radius:50%;background:#0d1a2e;"><tr>
            <td align="center" style="width:42px;height:42px;font-size:12px;letter-spacing:0.06em;color:#D4B896;font-weight:500;">${escHtml(initials)}</td>
          </tr></table>
        </td>
        <td style="vertical-align:middle;">
          <p style="margin:0 0 2px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:#9b8f7d;">Originally assigned to</p>
          <p style="margin:0;font-size:15px;font-weight:500;color:#1a1a1a;">${escHtml(ownerName)}</p>
        </td>
      </tr></table>
      <p style="margin:12px 0 0;font-size:12.5px;line-height:1.6;color:#6b6b6b;">This enquiry has been auto-reassigned to them. If they&rsquo;re out of office, keep it warm.</p>
    </td></tr></table>
  </td></tr>`;
  })() : '';

  const field = (label, value) => value ? `
    <td class="sl-half" width="50%" style="vertical-align:top;padding:0 10px 15px 0;">
      <p style="margin:0 0 3px;font-size:9px;letter-spacing:0.16em;color:#9b9b9b;text-transform:uppercase;">${label}</p>
      <p style="margin:0;font-size:12.5px;color:#1a1a1a;font-weight:500;word-break:break-word;">${escHtml(String(value))}</p>
    </td>` : '';

  // Pairs whatever cells actually exist into rows, two up, so a missing value
  // never leaves a hole. Only the final row can be half empty.
  const pairUp = cells => cells.filter(Boolean).reduce((acc, cell, i, arr) =>
    i % 2 ? acc : acc + `<tr>${cell}${arr[i + 1] || '<td class="sl-half" width="50%"></td>'}</tr>`, '');

  // Same as field(), but the value renders as a pill. Used for the one fact the
  // team triages a partner lead on.
  const fieldPill = (label, value) => value ? `
    <td class="sl-half" width="50%" style="vertical-align:top;padding-bottom:15px;">
      <p style="margin:0 0 5px;font-size:9px;letter-spacing:0.16em;color:#9b9b9b;text-transform:uppercase;">${label}</p>
      <span style="display:inline-block;padding:6px 14px;border-radius:100px;background:rgba(184,150,110,0.14);border:0.5px solid rgba(184,150,110,0.45);font-size:12.5px;font-weight:500;color:#8a6540;line-height:1.3;">${escHtml(String(value))}</span>
    </td>` : '';

  // Partner portals get their own layout, matched to the co-branded guest
  // email. The three banners above are shared: each is a self-contained table
  // row, so it drops into either shell unchanged.
  const partnerHtml = !portal ? '' : (function () {
    const isPaige  = !!routedAssigneeId(p);
    const building = (p.building || '').trim();
    const phone    = (p.phone || '').trim();

    const kv = (label, value, gold) => value ? `
            <td class="sl-half" width="50%" style="vertical-align:top;padding-bottom:15px;">
              <p style="margin:0 0 3px;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#9b9b9b;">${label}</p>
              <p style="margin:0;font-size:13.5px;font-weight:500;color:${gold ? '#B8966E' : '#1a1a1a'};">${value}</p>
            </td>` : '';

    const kvPill = (label, value) => `
            <td class="sl-half" width="50%" style="vertical-align:top;padding-bottom:15px;">
              <p style="margin:0 0 5px;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#9b9b9b;">${label}</p>
              <span style="display:inline-block;padding:6px 15px;border-radius:100px;background:rgba(184,150,110,.14);border:.5px solid rgba(184,150,110,.45);font-size:13px;font-weight:500;color:#8a6540;line-height:1.3;">${escHtml(String(value || 'Not specified'))}</span>
            </td>`;

    // Who the lead lands with, and what the guest was told to expect. Paige is
    // named in her version of the guest email, so the two sides match.
    const ownerBlock = isPaige ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F2;border-radius:10px;margin:0 0 22px;"><tr><td style="padding:14px 18px;">
      <table cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;padding-right:14px;width:46px;">
          <img src="${EMAIL_IMG.paige}" alt="Paige Grinter" width="46" height="46" style="width:46px;height:46px;display:block;border-radius:50%;object-fit:cover;">
        </td>
        <td style="vertical-align:middle;">
          <p style="margin:0 0 2px;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#9b8f7d;">Auto-assigned to</p>
          <p style="margin:0;font-size:14px;font-weight:500;color:#1a1a1a;">Paige Grinter <span style="font-weight:400;color:#9b8f7d;">&middot; to send PBSA + our cheapest options</span></p>
        </td>
      </tr></table>
    </td></tr></table>` : `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F2;border-radius:10px;margin:0 0 22px;"><tr><td style="padding:14px 18px;">
      <p style="margin:0 0 2px;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#9b8f7d;">Sent to Leads Board</p>
      <p style="margin:0;font-size:14px;font-weight:500;color:#1a1a1a;">Reservations team <span style="font-weight:400;color:#9b8f7d;">&middot; please deal with it like a normal enquiry</span></p>
    </td></tr></table>`;

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>New enquiry, ${escHtml(guestName)}</title>
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  :root{color-scheme:light dark;supported-color-schemes:light dark}
  .sl-dark{background-color:#000000!important}
  .sl-on-dark{color:#ffffff!important}
  .sl-on-dark-gold{color:#D4B896!important}
  @media (prefers-color-scheme:dark){
    .sl-dark{background-color:#000000!important}
    .sl-on-dark{color:#ffffff!important}
    .sl-on-dark-gold{color:#D4B896!important}
  }
  @media (max-width:620px){
    .sl-pad{padding-left:22px!important;padding-right:22px!important}
    .sl-half{display:block!important;width:100%!important}
    .sl-foot-line{font-size:12.5px!important;line-height:1.4!important}
    .sl-hd-logo{height:38px!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#EDE9E1;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#EDE9E1;padding:32px 16px;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:.5px solid rgba(0,0,0,.15);">

  <!-- Single centred band, no side-by-side cells: those break up on phones.
       Partner mark only, over the hero photo with a black wash. Outlook drops
       the photo and keeps the bgcolor. -->
  <tr><td class="sl-pad sl-dark" bgcolor="#000000" background="${EMAIL_IMG.hero}" style="background-color:#000000;background-image:linear-gradient(rgba(0,0,0,.7),rgba(0,0,0,.7)),url('${EMAIL_IMG.hero}');background-size:cover;background-position:center;background-repeat:no-repeat;padding:20px 32px 18px;text-align:center;">
    <img class="sl-hd-logo" src="${EMAIL_IMG.schoolAlt}" alt="${escHtml(portal.school)}" height="44" style="height:44px;width:auto;max-width:100%;display:block;margin:0 auto 12px;">
    <p class="sl-on-dark-gold" style="margin:0 0 5px;font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:#D4B896;">New Enquiry</p>
    <p class="sl-on-dark" style="margin:0 0 5px;font-family:Georgia,serif;font-size:24px;color:#ffffff;letter-spacing:-.035em;line-height:1.2;">${escHtml(guestName)}</p>
    <p class="sl-on-dark" style="margin:0;font-size:11.5px;color:rgba(255,255,255,.6);">${submittedFormatted}</p>
  </td></tr>
  ${mondayErrorBanner}
  ${omittedBanner}
  ${dupBannerHtml}

  <tr><td class="sl-pad" style="padding:26px 32px 0;">
    ${ownerBlock}

    <p style="margin:0 0 12px;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:#8B6E4E;">The enquiry</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(184,150,110,.35);border-radius:10px;"><tr><td style="padding:18px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0">${pairUp([
        kvPill('Accommodation type', formatAptType(p.apartment_type)),
        kv('Building', escHtml(building), true),
        kv('Guide price', p.budget ? escHtml(formatBudget(p.budget, p) + ' /' + budgetPeriod(p.city)) : ''),
        kv('Preferred areas', escHtml(formatArea(p.areas))),
        kv('Check-in', formatDate(p.check_in)),
        kv('Check-out', formatDate(p.check_out)),
        kv('Nights', nightCount ? nightCount + ' nights' : ''),
        kv('City', escHtml(formatCity(p.city) || portal.city)),
      ])}
      </table>
    </td></tr></table>

    ${p.message ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 0;"><tr>
      <td style="background:#FBF8F2;border-left:3px solid #B8966E;border-radius:0 8px 8px 0;padding:14px 16px;">
        <p style="margin:0 0 4px;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#8B6E4E;">Message from guest</p>
        <p style="margin:0;font-size:13px;color:#1a1a1a;line-height:1.7;font-style:italic;">&ldquo;${escHtml(p.message)}&rdquo;</p>
      </td>
    </tr></table>` : ''}

    <p style="margin:24px 0 12px;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:#8B6E4E;">Contact</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(184,150,110,.35);border-radius:10px;"><tr><td style="padding:18px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0">${pairUp([
        kv('Name', escHtml(p.full_name || '')),
        p.response_methods ? `
            <td class="sl-half" width="50%" style="vertical-align:top;padding-bottom:12px;">
              <p style="margin:0 0 5px;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#9b9b9b;">Respond via</p>
              <p style="margin:0;line-height:1;">${responseMethodPills(p.response_methods)}</p>
            </td>` : '',
        kv('Email', p.email ? `<a href="mailto:${escHtml(p.email)}" style="color:#1a1a1a;text-decoration:none;">${escHtml(p.email)}</a>` : ''),
        kv('Phone', phone ? `<a href="tel:${escHtml(phone.replace(/\s/g, ''))}" style="color:#1a1a1a;text-decoration:none;">${escHtml(phone)}</a>` : ''),
        kv('Timezone', escHtml(p.timezone || '')),
        kv('University', escHtml(portal.channel)),
      ])}
      </table>
    </td></tr></table>

    <p style="margin:24px 0 12px;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:#8B6E4E;">Tracking</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F2;border-radius:10px;"><tr><td style="padding:14px 18px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:3px 0;font-size:11.5px;color:#9b9b9b;width:150px;">Lead source (where)</td><td style="padding:3px 0;font-size:11.5px;color:#1a1a1a;font-weight:500;">${escHtml(leadSource || '—')}</td></tr>
        <tr><td style="padding:3px 0;font-size:11.5px;color:#9b9b9b;">Lead source (how)</td><td style="padding:3px 0;font-size:11.5px;color:#1a1a1a;font-weight:500;">${escHtml(leadChannel || '—')}</td></tr>
        <tr><td style="padding:3px 0;font-size:11.5px;color:#9b9b9b;">Form</td><td style="padding:3px 0;font-size:11.5px;color:#1a1a1a;font-weight:500;">${escHtml(portal.formName)}</td></tr>
      </table>
    </td></tr></table>
  </td></tr>

  <tr><td class="sl-pad" style="padding:24px 32px 28px;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td><a href="${crmUrl}" style="display:inline-block;padding:11px 22px;background:#B8966E;border-radius:8px;font-size:12px;font-weight:500;color:#ffffff;text-decoration:none;">Open in Leads Board</a></td>
    </tr></table>
  </td></tr>

  <!-- Footer is the guest email's, unchanged, so both sides of the enquiry
       close the same way. -->
  <tr><td class="sl-pad sl-dark" bgcolor="#000000" background="${EMAIL_IMG.footer}" style="background-color:#000000;background-image:linear-gradient(rgba(0,0,0,.8),rgba(0,0,0,.8)),url('${EMAIL_IMG.footer}');background-size:cover;background-position:center;background-repeat:no-repeat;padding:30px 32px;">
    <img src="${EMAIL_IMG.wordmark}" alt="Student Luxe" height="21" style="height:21px;width:auto;display:block;margin:0 auto 18px;">
    <p class="sl-on-dark sl-foot-line" style="margin:0 0 8px;text-align:center;font-family:Georgia,serif;font-size:15px;color:#ffffff;letter-spacing:-.01em;">The accommodation office for ${escHtml(portal.school)}</p>
    <p style="margin:0 0 16px;text-align:center;font-size:12px;line-height:1.7;color:rgba(255,255,255,.6);">Dog &amp; Duck Yard, Princeton St, London WC1R 4BH<br>+44 (0)203 007 0017 &middot; Mon to Fri, 10am to 6pm</p>
    <p style="margin:0;text-align:center;font-size:11.5px;"><a href="${EMAIL_IMG.page}" style="color:#D4B896;text-decoration:none;border-bottom:1px solid rgba(184,150,110,.45);">Back to the Accommodation Hub</a></p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
  })();

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>New enquiry, ${escHtml(guestName)}</title>
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  :root{color-scheme:light dark;supported-color-schemes:light dark}
  /* The wordmark is white artwork on transparency, so its band stays dark in
     every scheme. */
  .sl-dark{background-color:#000000!important}
  .sl-on-dark{color:#ffffff!important}
  .sl-on-dark-gold{color:#D4B896!important}
  @media (prefers-color-scheme:dark){
    .sl-dark{background-color:#000000!important}
    .sl-on-dark{color:#ffffff!important}
    .sl-on-dark-gold{color:#D4B896!important}
  }
@media only screen and (max-width:600px){
  .sl-t-outer { padding:0 !important; }
  .sl-t-card { border-radius:0 !important; border-left:none !important; border-right:none !important; }
  .sl-t-body { padding:16px 14px 0 !important; }
  .sl-pad { padding-left:14px !important; padding-right:14px !important; }
  .sl-cardpad { padding:14px 14px !important; }
  .sl-hd-logo { height:19px !important; }
  .sl-half { padding-right:10px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" class="sl-t-outer" style="background:#f4f1ec;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" class="sl-t-card" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.3);">
  <!-- Single centred band, no side-by-side cells: those break up on phones.
       Wordmark over an apartment photo with a black wash. Outlook drops the
       photo and keeps the bgcolor. -->
  <tr><td class="sl-pad sl-dark" bgcolor="#000000" background="${EMAIL_IMG.footer}" style="background-color:#000000;background-image:linear-gradient(rgba(0,0,0,.55),rgba(0,0,0,.55)),url('${EMAIL_IMG.footer}');background-size:cover;background-position:center;background-repeat:no-repeat;padding:20px 32px 18px;text-align:center;">
    <img class="sl-hd-logo" src="${EMAIL_IMG.wordmark}" alt="Student Luxe" height="22" style="height:22px;width:auto;max-width:100%;display:block;margin:0 auto 22px;">
    <p class="sl-on-dark-gold" style="margin:0 0 5px;font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:#D4B896;">New Enquiry</p>
    <p class="sl-on-dark" style="margin:0 0 5px;font-family:Georgia,serif;font-size:24px;color:#ffffff;letter-spacing:-.035em;line-height:1.2;">${escHtml(guestName)}</p>
    <p class="sl-on-dark" style="margin:0;font-size:11.5px;color:${duplicateOf ? '#e8c96b' : 'rgba(255,255,255,.6)'};">${duplicateOf ? '&#9888;&#65039; &nbsp;Possible duplicate' : submittedFormatted}</p>
  </td></tr>
  ${mondayErrorBanner}
  ${omittedBanner}
  ${dupBannerHtml}
  <tr><td class="sl-t-body" style="background:#ffffff;padding:20px 32px 0;">
    <p style="margin:0 0 10px;"><span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:500;letter-spacing:0.06em;background:${isTypeA ? 'rgba(29,158,117,0.12)' : 'rgba(184,150,110,0.12)'};color:${isTypeA ? '#0F6E56' : '#8a6540'};border:0.5px solid ${isTypeA ? 'rgba(29,158,117,0.4)' : 'rgba(184,150,110,0.4)'};">${isTypeA ? 'Check apartment availability' : 'Send guest options'}</span></p>
    <p style="margin:0;font-size:13px;color:#1a1a1a;line-height:1.75;">${isTypeA
      ? `${escHtml(p.apartment_ref || '')}${p.apartment_type ? ' — ' + formatAptType(p.apartment_type) : ''}${nightCount ? ' &nbsp;·&nbsp; ' + nightCount + ' nights' : ''}${p.check_in ? ' &nbsp;·&nbsp; ' + formatDate(p.check_in) + ' → ' + formatDate(p.check_out) : ''}`
      : `${formatCity(p.city) || ''}${p.apartment_type ? ' — ' + formatAptType(p.apartment_type) : ''}${nightCount ? ' &nbsp;·&nbsp; ' + nightCount + ' nights' : ''}${p.check_in ? ' &nbsp;·&nbsp; ' + formatDate(p.check_in) + ' → ' + formatDate(p.check_out) : ''}${p.budget && p.enquiry_type !== 'A' ? ' &nbsp;·&nbsp; ' + formatBudget(p.budget, p) + '/' + (budgetPeriod(p.city) === 'week' ? 'wk' : 'mo') : ''}`
    }</p>
  </td></tr>
  <tr><td class="sl-pad" style="background:#ffffff;padding:22px 32px 0;">
    <p style="margin:0 0 12px;font-size:9.5px;letter-spacing:0.16em;color:#8B6E4E;text-transform:uppercase;">Contact</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(184,150,110,0.35);border-radius:10px;"><tr><td class="sl-cardpad" style="padding:18px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0">${pairUp([
      field('Name', p.full_name),
      p.response_methods ? `
    <td class="sl-half" width="50%" style="vertical-align:top;padding:0 10px 12px 0;">
      <p style="margin:0 0 5px;font-size:9px;letter-spacing:0.16em;color:#9b9b9b;text-transform:uppercase;">Respond via</p>
      <p style="margin:0;line-height:1;">${responseMethodPills(p.response_methods)}</p>
    </td>` : '',
      field('Email', p.email),
      field('Phone', p.phone),
      field('Timezone', p.timezone),
    ])}
    </table>
    </td></tr></table>
  </td></tr>
  ${p.message ? `
  <tr><td class="sl-pad" style="background:#ffffff;padding:18px 32px 0;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="background:#FBF8F2;border-left:3px solid #B8966E;border-radius:0 8px 8px 0;padding:14px 16px;">
        <p style="margin:0 0 4px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:#8B6E4E;">Message from guest</p>
        <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.7;font-style:italic;">"${escHtml(p.message)}"</p>
      </td></tr>
    </table>
  </td></tr>` : ''}
  <tr><td class="sl-pad" style="background:#ffffff;padding:22px 32px 0;">
    <p style="margin:0 0 12px;font-size:9.5px;letter-spacing:0.16em;color:#8B6E4E;text-transform:uppercase;">Enquiry details</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(184,150,110,0.35);border-radius:10px;"><tr><td class="sl-cardpad" style="padding:18px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0">${pairUp(portal ? [
      field('City', formatCity(p.city)),
      fieldPill('Accommodation type', formatAptType(p.apartment_type)),
      field('Guide price', formatBudget(p.budget, p)),
      field('Check-in', formatDate(p.check_in)),
      field('Check-out', formatDate(p.check_out)),
      field('Nights', nightCount),
      field('Areas', formatArea(p.areas)),
      field('University', portal.channel),
    ] : [
      field('Enquiry type', isTypeA ? 'Check availability for guest' : 'Send guest options'),
      isTypeA ? field('Apartment', p.apartment_ref) : field('City', formatCity(p.city)),
      field('Apartment type', formatAptType(p.apartment_type)),
      field('Check-in', formatDate(p.check_in)),
      field('Check-out', formatDate(p.check_out)),
      field('Nights', nightCount),
      field('Budget / ' + budgetPeriod(p.city), p.enquiry_type !== 'A' ? formatBudget(p.budget, p) : ''),
      field('Areas', formatArea(p.areas)),
      field('Type of stay', formatStayType(p.stay_type, p.university)),
      field('Country of residence', p.nationality),
      field('Lived in city before', p.lived_before),
    ])}
    </table>
    </td></tr></table>
  </td></tr>

  <tr><td class="sl-pad" style="background:#ffffff;padding:22px 32px 24px;">
    <p style="margin:0 0 12px;font-size:9.5px;letter-spacing:0.16em;color:#8B6E4E;text-transform:uppercase;">Tracking</p>
    <table cellpadding="0" cellspacing="0" style="background:#FBF8F2;border-radius:10px;padding:10px 16px;width:100%;">
      <tr><td style="padding:3px 0;font-size:11px;color:#9b9b9b;width:160px;">Submitted</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;font-weight:500;">${submittedFormatted}</td></tr>
      <tr><td style="padding:3px 0;font-size:11px;color:#9b9b9b;">Lead Source (Where)</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;font-weight:500;">${escHtml(leadSource||'—')}</td></tr>
      <tr><td style="padding:3px 0;font-size:11px;color:#9b9b9b;">Lead Source (How)</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;font-weight:500;">${escHtml(leadChannel||'—')}</td></tr>
      ${(p.utm_term || '').trim() ? `<tr><td style="padding:3px 0;font-size:11px;color:#9b9b9b;">Search term</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;font-weight:500;">${escHtml(p.utm_term.trim())}</td></tr>` : ''}
      ${leadSource === 'PPC' && bestCampaign(p) ? `<tr><td style="padding:3px 0;font-size:11px;color:#9b9b9b;">Campaign</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;font-weight:500;">${escHtml(bestCampaign(p))}</td></tr>` : ''}
    </table>
  </td></tr>
  <tr><td class="sl-pad" style="background:#FBF8F2;padding:18px 32px;text-align:center;">
    <a href="${quoteUrl}" style="display:inline-block;padding:12px 26px;background:#B8966E;border-radius:8px;font-size:12.5px;font-weight:500;color:#ffffff;text-decoration:none;">${mondayId ? 'Open in Quote Tool' : 'Open the Leads Board'}</a>
    ${mondayId ? `<p style="margin:10px 0 0;font-size:11px;letter-spacing:0.06em;color:#9b9b9b;">Ref #${escHtml(String(mondayId))}</p>` : ''}
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  return resendSend({
    from:    portal
      ? `${portal.fromName} <${portal.fromEmail}>`
      : `${process.env.FROM_NAME || 'Student Luxe'} <${process.env.FROM_EMAIL}>`,
    // Partner routing: PBSA and undecided enquiries are Paige's, and she reads
    // the partner alias, so they stop there. Anything the sales team actually
    // sells (private apartments, serviced) also goes to the Reservations inbox
    // so it is worked like any other lead.
    to:      portal
      ? (routedAssigneeId(p)
          ? [portal.fromEmail]
          : [...new Set([portal.fromEmail, process.env.TEAM_EMAIL, process.env.TEAM_EMAIL_2].filter(Boolean))])
      : [process.env.TEAM_EMAIL, process.env.TEAM_EMAIL_2].filter(Boolean),
    // Reply goes to the guest, not back to the partner alias (which is itself an
    // alias of the team inbox, so Reply would otherwise be self-addressed).
    // Resend expects snake_case here; replyTo is silently dropped.
    reply_to: p.email,
    subject: portal
      ? `Marangoni Enquiry - ${formatAptType(p.apartment_type) || 'Accommodation'}${nightCount ? ', ' + nightCount + ' nights' : ''}`
      : isTypeA
      ? `New Guest Enquiry — ${p.apartment_ref || 'Specific Apartment'}${nightCount ? ', ' + nightCount + ' Nights' : ''}`
      : `New Guest Enquiry — ${formatCity(p.city) || 'Unknown City'}${nightCount ? ', ' + nightCount + ' Nights' : ''}`,
    html: portal ? partnerHtml : html
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
    // "Istituto Marangoni (London)" on the Partnerships board (5441673917),
    // linked from the lead via board_relation_mksyf45t.
    partnershipItemId: 9281289665,
  },
};

function partnerPortal(p) {
  return PARTNER_PORTALS[(p.enquiry_source || '').trim()] || null;
}

// Auto-assignment by accommodation type, per partner portal. PBSA and
// undecided enquiries need someone who works the provider relationships
// rather than our own stock, so they route to a named owner instead of
// sitting unassigned in the queue.
const PARTNER_ROUTING = {
  'istituto-marangoni-landing': {
    aptTypes:   ['shared', 'unsure'],
    assigneeId: 74955583,              // Paige Grinter
  },
};

// Returns a Monday user id, or null when the enquiry is not covered by a rule.
function routedAssigneeId(p) {
  const rule = PARTNER_ROUTING[(p.enquiry_source || '').trim()];
  if (!rule) return null;
  return rule.aptTypes.includes((p.apartment_type || '').trim()) ? rule.assigneeId : null;
}

function computeLeadSource(p) {
  // Partnership portals (co-branded pages hosted for a partner institution)
  // are always credited to the partner, never to the ad or search that first
  // brought the guest to that partner's own site. Checked before every other
  // signal so a stray gclid cannot reclassify the lead as PPC.
  const partner = partnerPortal(p);
  if (partner) return { leadSource: 'Partnerships', leadChannel: partner.channel };

  // Affiliate / partner UTM links (utm_medium=affiliate, or utm_source=partner).
  // Credited to Partnerships, with the specific partner resolved from
  // utm_campaign. Checked before PPC/social so an affiliate link that also
  // carries a stray gclid still classifies as a partnership. Add new partners
  // to AFFILIATE_CHANNELS as they launch.
  const AFFILIATE_CHANNELS = {
    'affiliate-expat':         'Expat.com',
    'affiliate-studyintheusa': 'Study in the USA'
  };
  const affSource = (p.utm_source || '').toLowerCase().trim();
  const affMedium = (p.utm_medium || '').toLowerCase().trim();
  if (affMedium === 'affiliate' || affSource === 'partner') {
    const camp = (p.utm_campaign || '').toLowerCase().trim();
    return { leadSource: 'Partnerships', leadChannel: AFFILIATE_CHANNELS[camp] || 'Partner' };
  }

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
  '23593406109':'jf17_search_generic_os_tablet_phrase_in_row_destination_london','23676288424':'jf14_search_generic_os_tablet_broad_in_us_destination_london - £150 tCPA Test','23671659281':'jf3_search_generic_os_desktop_broad_in_us_destination_london - £150 tCPA Test','23598174873':'jf19_search_brand_global_exact','21918787893':'rentals-short-stay-os','23512016561':'cambridge-os','24033037380':'cambridge-uk','23976477068':'JF_Competitors_Exact','24034455964':'milan-os','24053226370':'london-rentals-uk','23921481987':'london-student-uk','23798686455':'chicago-os','24049773782':'jf_london-student-os-university','24119110682':'perf-max-us-euro','23885864121':'jf19_search_brand_global_phrase','23884443050':'hnwi-pb-zip-os-expansion','20356089756':'london-student-os','23603515408':'jf10_search_generic_os_mobile_exact_in_us_destination_london','23593407051':'jf9_search_generic_os_mobile_exact_in_row_destination_london','22561087901':'core-luxe-perf-max','23392672745':'new-york-os','21429830124':'lse-summer-uni-campus','23676301570':'jf9_search_generic_os_mobile_exact_in_row_destination_london - £150 tCPA Test','21973944922':'core-luxe-os','23671673024':'jf4_search_generic_os_desktop_exact_in_row_destination_london - £150 tCPA Test','23593406838':'jf12_search_generic_os_mobile_phrase_in_us_destination_london','23666278518':'jf13_search_generic_os_tablet_broad_in_row_destination_london - £150 tCPA Test','21902352633':'lse-summer-all-us','21499603565':'paris-os','23676319627':'jf15_search_generic_os_tablet_exact_in_row_destination_london - £150 tCPA Test','23593627429':'jf16_search_generic_os_tablet_exact_in_us_destination_london','23452513132':'lse-summer-perf-max','23642461894':'paris-os-exp','23666244384':'jf8_search_generic_os_mobile_broad_in_us_destination_london - £150 tCPA Test','23666254497':'jf5_search_generic_os_desktop_exact_in_us_destination_london - £150 tCPA Test','22082273952':'rentals-os','22120262100':'hnwi-pb-zip-os','23588980553':'jf3_search_generic_os_desktop_broad_in_us_destination_london','23671661003':'jf6_search_generic_os_desktop_phrase_in_us_destination_london - £150 tCPA Test','23593627561':'jf18_search_generic_os_tablet_phrase_in_us_destination_london','23676326599':'jf17_search_generic_os_tablet_phrase_in_row_destination_london - £150 tCPA Test','23588981654':'jf14_search_generic_os_tablet_broad_in_us_destination_london','23671688303':'jf18_search_generic_os_tablet_phrase_in_us_destination_london - £150 tCPA Test','23666271564':'jf10_search_generic_os_mobile_exact_in_us_destination_london - £150 tCPA Test','23593406301':'jf7_search_generic_os_mobile_broad_in_row_destination_london','23598893477':'jf2_search_generic_os_desktop_broad_in_row_destination_london','23676311422':'jf2_search_generic_os_desktop_broad_in_row_destination_london - £150 tCPA Test','23666273505':'jf12_search_generic_os_mobile_phrase_in_us_destination_london - £150 tCPA Test','23666255946':'jf11_search_generic_os_mobile_phrase_in_row_destination_london - £150 tCPA Test','23603514478':'jf13_search_generic_os_tablet_broad_in_row_destination_london','23598893927':'jf11_search_generic_os_mobile_phrase_in_row_destination_london','23598893684':'jf1_search_generic_os_desktop_phrase_in_row_destination_london','23642456119':'lse-summer-all-us-exp','23593406142':'jf15_search_generic_os_tablet_exact_in_row_destination_london','23671689740':'jf16_search_generic_os_tablet_exact_in_us_destination_london - £150 tCPA Test','23593406559':'jf8_search_generic_os_mobile_broad_in_us_destination_london',
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
    text8:             p.city === 'other' ? (p.other_city || 'Other (not specified)') : (formatCity(p.city) || ''),
    dropdown6:         buildingRef(p) || p.apartment_ref || '',
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
    // The full school name ("Istituto Marangoni London"), not the shorter
    // channel label, so the University column matches how the team writes it.
    text_mknfnmsb: partnerPortal(p)?.school || p.university || '',
    text_mm5asah0: p.course      || '',
    // Nationality is optional on the main form and always posts empty from
    // the modal forms, so fall back to the geo-IP country. It is where they
    // submitted from, not a stated nationality, but an educated guess beats
    // an empty column for segmenting.
    text9__1:      p.nationality || countryName(p.country) || '',
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
    text_mm4ntp4n: resolveCampaign((p.first_touch && p.first_touch.campaign) || p.first_campaign || ''), // first_campaign (resolved: the raw id leaked through before)
    text_mm4ncd41: p.gbraid     || '',                                                       // gbraid
    text_mm4n9t2x: p.wbraid     || '',                                                       // wbraid
    text_mm4n9415: p.session_id || '',                                                       // session_id
    ...(duplicateOf && { color_mknqvzde: { label: 'Possible Duplicate' } }),
    // Type-based routing first, so the duplicate's existing owner below can
    // override it. A returning guest stays with whoever already knows them.
    ...(routedAssigneeId(p) && {
      people_1: { personsAndTeams: [{ id: routedAssigneeId(p), kind: 'person' }] }
    }),
    ...(duplicateOf?.assigneeIds?.length > 0 && {
      people_1: { personsAndTeams: duplicateOf.assigneeIds.map(id => ({ id, kind: 'person' })) }
    }),
    ...(leadSource  && { color_mkxk8y67: { label: leadSource } }),
    ...(leadChannel && leadChannel !== 'Unknown' && { dropdown_mkxkfbff: { labels: [leadChannel] } }),
    dropdown_mm1v31yb: { labels: [partnerPortal(p)?.formName || '/Reservations Form'] },
    // Partner portal leads are flagged on the Group / Partnership Label column
    // so the board can group and report on them without reading the source.
    ...(partnerPortal(p) && { status1__1: { label: 'Partnership / Agency Booking' } }),
    ...(partnerPortal(p)?.partnershipItemId && { board_relation_mksyf45t: { item_ids: [partnerPortal(p).partnershipItemId] } }),
    ...(p.city && currencyForCity(p.city, p.other_city) && { status0__1: { label: currencyForCity(p.city, p.other_city) } }),
  };

  const createItem = async (cv) => {
    const mutation = `
    mutation {
      create_item(
        board_id: ${MONDAY_BOARD},
        item_name: ${JSON.stringify(itemName)},
        column_values: ${JSON.stringify(JSON.stringify(cv))},
        create_labels_if_missing: true
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
  };

  // First push the full column set. If Monday rejects a specific column value
  // (ColumnValueException, e.g. a malformed email like "name,s@gmail.com"),
  // strip the guilty column(s), record the rejected raw values in the notes
  // column, and push again so the lead still lands on the board instead of
  // failing entirely. p._omittedFields feeds the team email warning banner.
  try {
    return await createItem(columnValues);
  } catch (err) {
    const msg = String(err.message || '');
    if (!/ColumnValueException|is not valid|invalid value/i.test(msg)) throw err;
    const omitted = stripGuiltyColumns(columnValues, msg, p);
    if (!omitted.length) throw err;
    p._omittedFields = omitted;
    console.warn('Monday rejected column value(s), retrying without:', omitted.map(o => o.label).join(', '));
    const note = 'REJECTED BY MONDAY, add manually: ' + omitted.map(o => o.label + ' = ' + (o.value || '(empty)')).join(' | ');
    columnValues.long_text7 = (columnValues.long_text7 ? columnValues.long_text7 + '\n\n' : '') + note;
    return await createItem(columnValues);
  }
}

// Map a Monday ColumnValueException back to the column(s) that caused it and
// remove them from the payload. Falls back to stripping every typed/validated
// column (plain text columns never throw) when the message names no culprit.
function stripGuiltyColumns (cv, msg, p) {
  const m = msg.toLowerCase();
  const groups = [
    { re: /email/,                       cols: [['email', 'Email', p.email]] },
    { re: /phone/,                       cols: [['phone_1', 'Phone', p.phone]] },
    { re: /date/,                        cols: [['date47', 'Check-in', p.check_in], ['date_1', 'Check-out', p.check_out]] },
    { re: /label|dropdown|status|color/, cols: [
      ['dropdown6', 'Apartment ref', buildingRef(p) || p.apartment_ref],
      ['apt_type_mkmn4bgg', 'Apartment type', p.apartment_type],
      ['dropdown19', 'Areas', p.areas],
      ['dropdown40', 'Response methods', p.response_methods],
      ['color_mktcnwyb', 'Stay type', p.stay_type],
      ['color_mkxk8y67', 'Lead source', ''],
      ['dropdown_mkxkfbff', 'Lead channel', ''],
      ['dropdown_mm1v31yb', 'Form', ''],
      ['status0__1', 'Currency', '']
    ] }
  ];
  const out = [];
  let matched = false;
  for (const g of groups) {
    if (!g.re.test(m)) continue;
    matched = true;
    g.cols.forEach(([id, label, value]) => {
      if (cv[id] !== undefined) { delete cv[id]; out.push({ id, label, value: value || '' }); }
    });
  }
  if (!matched) {
    groups.forEach(g => g.cols.forEach(([id, label, value]) => {
      if (cv[id] !== undefined) { delete cv[id]; out.push({ id, label, value: value || '' }); }
    }));
    if (cv.people_1 !== undefined) { delete cv.people_1; out.push({ id: 'people_1', label: 'Assignees', value: '' }); }
  }
  return out;
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
  const map = {'london':'London','new-york':'New York','paris':'Paris','edinburgh':'Edinburgh','glasgow':'Glasgow','manchester':'Manchester','cambridge':'Cambridge','durham':'Durham','bristol':'Bristol','barcelona':'Barcelona','madrid':'Madrid','lisbon':'Lisbon','boston':'Boston','chicago':'Chicago','washington':'Washington DC','amsterdam':'Amsterdam','milan':'Milan','rome':'Rome','florence':'Florence','helsinki':'Helsinki','porto':'Porto','valencia':'Valencia','birmingham':'Birmingham','brighton':'Brighton','liverpool':'Liverpool','nottingham':'Nottingham','dublin':'Dublin','philadelphia':'Philadelphia','los-angeles':'Los Angeles'};
  return map[city] || city;
}
// Partner-portal cards (the Marangoni PBSA blocks) post the building the guest
// clicked. Monday wants one readable value in dropdown6, e.g.
// "Standard student living - Hoxton". Without a building this returns '' so the
// column falls back to the site's own apartment_ref.
function buildingRef (p) {
  const b = (p && p.building || '').trim();
  if (!b) return '';
  const type = formatAptType(p.apartment_type);
  return type ? type + ' - ' + b : b;
}

function formatAptType(t) {
  if (!t) return '';
  const map = {'studio':'Studio','1bed':'1 bedroom','2bed':'2 bedroom','3bed':'3 bedroom','penthouse':'Penthouse','flexible':'Flexible',
    // Partner portals ask for a living category rather than a unit size.
    'shared':'Standard student living','private':'Private apartments','serviced':'Luxury serviced apartments',
    // Guest picked "Not sure yet" on the Marangoni modal, i.e. they want a
    // recommendation rather than a category.
    'unsure':'Not sure yet'};
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

// The reservations form quotes UK-tier cities per WEEK and every other city
// per MONTH (see getBudgetPeriod / CITY_TIER in the form's code block). The
// emails used to hardcode "per week", so a US or EU guest was shown a monthly
// band labelled weekly. Keep this list in step with the form's uk-A / uk-2
// tiers. Note Dublin is a UK-tier (weekly) city despite being in euros.
const WEEKLY_BUDGET_CITIES = ['london','edinburgh','glasgow','manchester','cambridge','durham','bristol','birmingham','brighton','liverpool','nottingham','dublin'];
function budgetPeriod (city) {
  return WEEKLY_BUDGET_CITIES.includes(String(city || '').toLowerCase().trim()) ? 'week' : 'month';
}

function formatBudget(b, p) {
  if (!b) return '';
  const map = {'under-650':'Under £650','650-1000':'£650 – £1,000','1000-2000':'£1,000 – £2,000','2000-4000':'£2,000 – £4,000','5000+':'£5,000+','under-550':'Under £550','550-900':'£550 – £900','900-1350':'£900 – £1,350','1350-2000':'£1,350 – £2,000','2000+':'£2,000+','850-1200':'£850 – £1,200','1200-2000':'£1,200 – £2,000','2000-3500':'£2,000 – £3,500','3500-5000':'£3,500 – £5,000','under-1250':'Under £1,250','1250-1800':'£1,250 – £1,800','1800-2500':'£1,800 – £2,500','2500-4000':'£2,500 – £4,000',
    // Marangoni portal. The live form now posts honest values ('350-650',
    // '585-1000', '1000-2000'), but the old stale ones stay mapped so leads
    // captured before the change still read correctly in Monday and email.
    '350-650':'£350 – £650','585-1000':'£585 – £1,000',
    '350-500':'£350 – £650','500-1000':'£650 – £1,000','1000-plus':'£1,000+',
    // Paired with apartment_type 'unsure'; without this the generic parser
    // below would mangle it.
    'unsure':'Not sure yet'};
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
// Channel colours for the team emails: the salesperson sorts by how to reply,
// so the channel carries the colour rather than the label. Anything unmapped
// falls back to a neutral pill instead of leaking a raw slug.
const CHANNEL_PILL = {
  whatsapp: { label: 'WhatsApp',     color: '#25923f' },
  wechat:   { label: 'WeChat',       color: '#25923f' },
  phone:    { label: 'Phone call',   color: '#1a5fb4' },
  call:     { label: 'Phone call',   color: '#1a5fb4' },
  sms:      { label: 'SMS',          color: '#1a5fb4' },
  text:     { label: 'Text message', color: '#1a5fb4' },
  email:    { label: 'Email',        color: '#B8966E' },
};
function responseMethodPills (v) {
  if (!v) return '';
  return String(v).split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const c = CHANNEL_PILL[x.toLowerCase()] || { label: x.charAt(0).toUpperCase() + x.slice(1), color: '#6b6b6b' };
    return `<span style="display:inline-block;padding:5px 13px;margin:0 6px 6px 0;border-radius:100px;background:${c.color};font-size:12px;font-weight:500;color:#ffffff;line-height:1.3;">${escHtml(c.label)}</span>`;
  }).join('');
}

// The forms post the preferred reply channels as a CSV of slugs
// ('whatsapp,email'). Both emails show them to a human, so they get proper
// labels and an Oxford-free comma list. Unknown slugs title-case rather than
// leak raw.
function formatResponseMethods(v) {
  if (!v) return '';
  const map = {'whatsapp':'WhatsApp','email':'Email','phone':'Phone call','call':'Phone call','sms':'SMS','text':'Text message','wechat':'WeChat'};
  return String(v).split(',').map(s => s.trim()).filter(Boolean)
    .map(s => map[s.toLowerCase()] || s.charAt(0).toUpperCase() + s.slice(1))
    .join(', ');
}
function formatStayType(type, university) {
  if (!type) return '';
  const map = {'student':'Student','parent':'Parent or guardian (on behalf of student)','working-professional':'Working professional','corporate':'Corporate','medical':'Medical','tourism':'Tourism','agent':'Agent (on behalf of client)'};
  const label = map[type] || type;
  return university ? `${label} · ${university}` : label;
}
