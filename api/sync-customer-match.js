// ============================================================
//  Student Luxe — Google Ads Customer Match sync
//  GET /api/sync-customer-match?force=1
//
//  Weekly cron: pulls every confirmed booking from Monday, hashes
//  email + phone + first/last name, pushes to a single Google Ads
//  Customer Match user list ("Luxe Confirmed Bookings"). Idempotent
//  by hash, so re-runs add new bookings only.
//
//  Customer Match user list = lookalike-modelling seed for Smart
//  Bidding. Targets similar audiences on Search + Performance Max.
// ============================================================

const MONDAY_API     = 'https://api.monday.com/v2';
const BOOKINGS_BOARD = 2171015589;
const LIST_NAME      = 'Luxe Confirmed Bookings';
const LIST_DESC      = 'PPC and non-PPC confirmed bookings, hashed identifiers. Auto-synced weekly from Monday.';
const MEMBERSHIP_DAYS = 540;          // Google's max for Customer Match
const BATCH_SIZE      = 1000;         // max operations per addOperations call
const INCLUDED_GROUPS = ['Confirmed Bookings'];
const LOGIN_CUSTOMER_ID = '6046238343';

module.exports = async function handler (req, res) {
  // CRON_SECRET guard (Vercel sets it as Authorization: Bearer <secret> for cron invocations)
  const isVercelCron = req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;
  const isForceCall  = req.query?.force === '1' && req.headers['x-sync-secret'] === process.env.CRON_SECRET;
  if (!isVercelCron && !isForceCall) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    console.log('Customer Match sync starting');

    // 1. Pull all confirmed bookings + their linked-lead identifiers
    const users = await fetchConfirmedBookingIdentifiers();
    console.log(`Found ${users.length} confirmed bookings with at least one identifier`);
    if (users.length === 0) {
      return res.status(200).json({ ok: true, synced: 0, reason: 'no bookings with identifiers' });
    }

    // 2. Google Ads access token
    const accessToken = await getAccessToken();
    const customerId  = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
    const headers     = {
      'Authorization':     `Bearer ${accessToken}`,
      'developer-token':   process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'login-customer-id': LOGIN_CUSTOMER_ID,
      'Content-Type':      'application/json'
    };

    // 3. Find or create the user list
    const listResource = await findOrCreateUserList(customerId, headers);
    console.log(`User list ready: ${listResource}`);

    // 4. Create an offline user data job
    const jobResource = await createJob(customerId, headers, listResource);
    console.log(`Job created: ${jobResource}`);

    // 5. Add operations in batches of 1000
    let added = 0;
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const chunk = users.slice(i, i + BATCH_SIZE);
      const ops = await Promise.all(chunk.map(buildOperation));
      await addOperations(customerId, headers, jobResource, ops.filter(Boolean));
      added += ops.filter(Boolean).length;
      console.log(`Added batch ${i + 1}-${i + chunk.length} (${added} total)`);
    }

    // 6. Run the job (async — Google processes in background, can take hours)
    await runJob(customerId, headers, jobResource);
    console.log('Job submitted to Google Ads. Processing happens async.');

    return res.status(200).json({
      ok:        true,
      list:      LIST_NAME,
      jobResource,
      synced:    added,
      bookings:  users.length
    });
  } catch (err) {
    console.error('sync-customer-match error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────────────────────
//  MONDAY — pull all confirmed bookings + linked lead identifiers
// ──────────────────────────────────────────────────────────────
async function fetchConfirmedBookingIdentifiers () {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 30; page++) {            // cap = 15k bookings
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const query = `query {
      boards(ids: [${BOOKINGS_BOARD}]) {
        items_page(limit: 500${cursorArg}) {
          cursor
          items {
            id name created_at
            group { title }
            column_values(ids: ["date9", "numeric_mm1ge9h4"]) { id text }
            relation: column_values(ids: ["link_to_leads26"]) {
              id
              ... on BoardRelationValue {
                linked_items {
                  id
                  column_values(ids: ["email", "phone_1", "text37", "text60"]) { id text }
                }
              }
            }
          }
        }
      }
    }`;
    const r = await fetch(MONDAY_API, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
      body:    JSON.stringify({ query })
    });
    const data = await r.json();
    if (data.errors) throw new Error('Monday: ' + JSON.stringify(data.errors));
    const items = data?.data?.boards?.[0]?.items_page?.items || [];
    items.forEach(it => {
      const groupTitle = it.group?.title || '';
      if (!INCLUDED_GROUPS.includes(groupTitle)) return;
      const linkedLead = it.relation?.[0]?.linked_items?.[0];
      if (!linkedLead) return;
      const lc = {};
      (linkedLead.column_values || []).forEach(c => { lc[c.id] = (c.text || '').trim(); });
      const email = lc.email     || '';
      const phone = lc.phone_1   || '';
      const first = lc.text37    || '';
      const last  = lc.text60    || '';
      if (!email && !phone) return;                // need at least one identifier
      out.push({ email, phone, first, last, bookingId: it.id, bookingDate: it.created_at });
    });
    cursor = data?.data?.boards?.[0]?.items_page?.cursor || null;
    if (!cursor) break;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
//  GOOGLE ADS — OAuth + Customer Match plumbing
// ──────────────────────────────────────────────────────────────
async function getAccessToken () {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('OAuth: ' + JSON.stringify(j));
  return j.access_token;
}

async function findOrCreateUserList (customerId, headers) {
  // 1. Search for existing list by name
  const searchUrl = `https://googleads.googleapis.com/v21/customers/${customerId}/googleAds:searchStream`;
  const r = await fetch(searchUrl, {
    method:  'POST',
    headers,
    body:    JSON.stringify({
      query: `SELECT user_list.resource_name, user_list.name, user_list.id
              FROM user_list
              WHERE user_list.name = '${LIST_NAME.replace(/'/g, "\\'")}'`
    })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`User list search HTTP ${r.status}: ${text.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Non-JSON: ' + text.slice(0, 200)); }
  const results = (Array.isArray(data) ? data : [data]).flatMap(s => s.results || []);
  if (results.length > 0) return results[0].userList.resourceName;

  // 2. Create the list
  const createUrl = `https://googleads.googleapis.com/v21/customers/${customerId}/userLists:mutate`;
  const cr = await fetch(createUrl, {
    method:  'POST',
    headers,
    body:    JSON.stringify({
      operations: [{
        create: {
          name:                LIST_NAME,
          description:         LIST_DESC,
          membershipLifeSpan:  MEMBERSHIP_DAYS,
          crmBasedUserList: {
            uploadKeyType: 'CONTACT_INFO'
          }
        }
      }]
    })
  });
  const ctext = await cr.text();
  if (!cr.ok) throw new Error(`User list create HTTP ${cr.status}: ${ctext.slice(0, 300)}`);
  const cdata = JSON.parse(ctext);
  return cdata.results?.[0]?.resourceName;
}

async function createJob (customerId, headers, listResource) {
  const url = `https://googleads.googleapis.com/v21/customers/${customerId}/offlineUserDataJobs:create`;
  const r = await fetch(url, {
    method:  'POST',
    headers,
    body:    JSON.stringify({
      job: {
        type: 'CUSTOMER_MATCH_USER_LIST',
        customerMatchUserListMetadata: { userList: listResource }
      }
    })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Job create HTTP ${r.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  return j.resourceName;
}

async function addOperations (customerId, headers, jobResource, ops) {
  if (!ops.length) return;
  const url = `https://googleads.googleapis.com/v21/${jobResource}:addOperations`;
  const r = await fetch(url, {
    method:  'POST',
    headers,
    body:    JSON.stringify({
      enablePartialFailure: true,
      enableWarnings:       true,
      operations:           ops
    })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`addOperations HTTP ${r.status}: ${text.slice(0, 500)}`);
  const j = JSON.parse(text);
  if (j.partialFailureError) {
    console.warn('addOperations partial failure:', JSON.stringify(j.partialFailureError).slice(0, 500));
  }
}

async function runJob (customerId, headers, jobResource) {
  const url = `https://googleads.googleapis.com/v21/${jobResource}:run`;
  const r = await fetch(url, { method: 'POST', headers });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Run job HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
}

// ──────────────────────────────────────────────────────────────
//  HASHING — Google requires SHA-256 of normalised values
// ──────────────────────────────────────────────────────────────
async function sha256 (str) {
  const data    = new TextEncoder().encode(str);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normEmail (e) { return (e || '').toLowerCase().trim(); }
function normPhone (p) {
  // E.164: keep leading +, strip everything else
  let v = (p || '').replace(/[^\d+]/g, '');
  if (!v) return '';
  if (!v.startsWith('+')) v = '+' + v;
  return v;
}
function normName  (n) { return (n || '').toLowerCase().trim().replace(/\s+/g, ' '); }

async function buildOperation (u) {
  const ids = [];
  const email = normEmail(u.email);
  if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    ids.push({ hashedEmail: await sha256(email) });
  }
  const phone = normPhone(u.phone);
  if (phone && phone.length >= 10) {
    ids.push({ hashedPhoneNumber: await sha256(phone) });
  }
  if (u.first && u.last) {
    ids.push({
      addressInfo: {
        hashedFirstName: await sha256(normName(u.first)),
        hashedLastName:  await sha256(normName(u.last)),
        countryCode:     'GB'   // Most bookings: London/UK based. Refine if you start collecting country.
      }
    });
  }
  if (ids.length === 0) return null;
  return { create: { userIdentifiers: ids } };
}
