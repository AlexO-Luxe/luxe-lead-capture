// ============================================================
//  Backfill missing campaign attribution on Leads from the gclid.
//  GET /api/enrich-attribution?secret=<CRON_SECRET>&limit=50&lookback=7[&dryRun=1]
//
//  Why this exists:
//  Under parallel tracking (mandatory on Search), UTM params that live
//  in a Google Ads *tracking template* never reach the landing page —
//  only auto-tagged gclid/gbraid do. So leads land with a gclid but no
//  campaign / ad group / keyword. There is also no valid ValueTrack macro
//  for the campaign NAME, so even a Final URL suffix can't reliably supply
//  it. The one source of truth is Google's own click_view resource, which
//  maps a gclid back to its real campaign / ad group / keyword / match type
//  for ~90 days.
//
//  This endpoint finds Leads with a gclid but an empty campaign column,
//  asks click_view what that click was, and writes the answer back to
//  Monday. Idempotent: a lead that already has a campaign is skipped by
//  the Monday-side filter, so re-running is safe.
//
//  Reads only (googleAds:search). The deprecated write path
//  (uploadClickConversions) is NOT touched — click_view reads still work
//  on the classic API, same as dashboard-gads.js.
// ============================================================

const MONDAY_API  = 'https://api.monday.com/v2';
const LEADS_BOARD = 2171015719;

// Leads board column IDs.
const COL_CLICKID   = 'text4__1';       // gclid || gbraid || wbraid || fbclid (gclid first)
const COL_GBRAID    = 'text_mm4ncd41';
const COL_WBRAID    = 'text_mm4n9t2x';
const COL_CAMPAIGN  = 'text_mm1c3b5w';
const COL_ADGROUP   = 'text43__1';
const COL_TERM      = 'text3__1';
const COL_MATCHTYPE = 'text_mm1d87rp';

const CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
const MCC_ID      = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '6046238343';

module.exports = async function handler (req, res) {
  // Auth: manual runs pass ?secret=; the Vercel cron authenticates via the
  // Authorization: Bearer <CRON_SECRET> header it injects automatically, so
  // the secret never has to live in vercel.json.
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (req.query?.secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const limit     = Math.max(1, Math.min(300, parseInt(req.query?.limit     || '50', 10)));
  const lookback  = Math.max(1, Math.min(90,  parseInt(req.query?.lookback  || '7',  10)));
  const maxAgeDays = Math.max(1, Math.min(92, parseInt(req.query?.maxAgeDays || '92', 10)));
  const dryRun    = req.query?.dryRun === '1';

  try {
    const candidates = await fetchCandidates(limit, maxAgeDays);
    const token      = await getAccessToken();

    const out = { candidates: candidates.length, limit, lookback, dryRun, results: [] };

    for (const lead of candidates) {
      const gclid = lead.clickId;

      // click_view only knows gclids. Skip braids (no queryable gclid) and
      // fbclid (Instagram, not a Google click).
      if (!looksLikeGclid(gclid, lead)) {
        out.results.push({ mondayId: lead.id, name: lead.name, outcome: 'skipped', reason: 'not a gclid' });
        continue;
      }

      let click = null;
      try {
        click = await lookupClick(token, gclid, lead.createdAt, lookback);
      } catch (err) {
        out.results.push({ mondayId: lead.id, name: lead.name, outcome: 'error', reason: err.message.slice(0, 200) });
        continue;
      }

      if (!click) {
        out.results.push({ mondayId: lead.id, name: lead.name, outcome: 'not-found', reason: `no click_view row within ${lookback}d` });
        continue;
      }

      const cols = {
        [COL_CAMPAIGN]:  click.campaign,
        [COL_ADGROUP]:   click.adGroup,
        [COL_TERM]:      click.keyword,
        [COL_MATCHTYPE]: click.matchType
      };

      if (dryRun) {
        out.results.push({ mondayId: lead.id, name: lead.name, outcome: 'would-write', ...cols });
        continue;
      }

      try {
        await writeColumns(lead.id, cols);
        out.results.push({ mondayId: lead.id, name: lead.name, outcome: 'enriched', ...cols });
      } catch (err) {
        out.results.push({ mondayId: lead.id, name: lead.name, outcome: 'error', reason: 'monday write: ' + err.message.slice(0, 150) });
      }
    }

    out.summary = out.results.reduce((a, r) => { a[r.outcome] = (a[r.outcome] || 0) + 1; return a; }, {});
    return res.status(200).json(out);
  } catch (err) {
    console.error('enrich-attribution error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Monday: pull leads with a click id but no campaign ─────────
// Newest first, and stop once leads fall past the click_view window
// (their gclid is expired on Google's side, so a lookup is wasted).
async function fetchCandidates (limit, maxAgeDays) {
  const leads    = [];
  const cutoffMs = Date.now() - maxAgeDays * 86400000;
  let   cursor   = null;

  while (leads.length < limit) {
    const pageQuery = cursor
      ? `query { next_items_page(limit: 100, cursor: ${JSON.stringify(cursor)}) {
           cursor
           items { id name created_at column_values(ids: ["${COL_CLICKID}", "${COL_GBRAID}", "${COL_WBRAID}"]) { id text } }
         } }`
      : `query { boards(ids: ${LEADS_BOARD}) {
           items_page(limit: 100, query_params: {
             rules: [
               { column_id: "${COL_CLICKID}",  compare_value: [""], operator: is_not_empty },
               { column_id: "${COL_CAMPAIGN}", compare_value: [""], operator: is_empty }
             ],
             operator: and,
             order_by: [{ column_id: "__creation_log__", direction: desc }]
           }) {
             cursor
             items { id name created_at column_values(ids: ["${COL_CLICKID}", "${COL_GBRAID}", "${COL_WBRAID}"]) { id text } }
           }
         } }`;

    const d    = await mondayQuery(pageQuery);
    const page = cursor ? d?.data?.next_items_page : d?.data?.boards?.[0]?.items_page;
    if (!page) break;

    let hitFloor = false;
    for (const it of (page.items || [])) {
      if (new Date(it.created_at || 0).getTime() < cutoffMs) { hitFloor = true; break; }
      const c = {};
      it.column_values.forEach(x => { c[x.id] = (x.text || '').trim(); });
      leads.push({
        id:        it.id,
        name:      it.name,
        createdAt: it.created_at,
        clickId:   c[COL_CLICKID],
        gbraid:    c[COL_GBRAID],
        wbraid:    c[COL_WBRAID]
      });
      if (leads.length >= limit) break;
    }

    cursor = page.cursor;
    if (hitFloor || !cursor) break;
  }
  return leads;
}

// The stored click id is a gclid unless it matches the braid columns or
// looks like a Meta click. gclids are urlsafe base64 (letters/digits/-/_)
// and start "Cj" / "EAIaIQ"; gbraid/wbraid start "0AAAA"; Meta fbclids
// start "IwAR" / "IwZX" / "PA" and often carry an "_aem_" segment.
// (Display/Demand-Gen gclids can't be pre-filtered by shape, so they fall
// through to a lookup that correctly returns not-found — click_view only
// holds Search + Shopping clicks.)
function looksLikeGclid (v, lead) {
  if (!v) return false;
  if (v === lead.gbraid || v === lead.wbraid) return false;
  if (/^0AAAA/.test(v)) return false;
  if (/^(IwAR|IwZX|PA)/.test(v) || v.includes('_aem_')) return false; // Meta
  if (/['"\\]/.test(v)) return false; // guard GAQL string injection
  return true;
}

// ── Google Ads: gclid -> campaign / ad group / keyword ─────────
// click_view can only be queried one day at a time. The click happened
// on or before the lead was created, so walk from the created day back.
async function lookupClick (token, gclid, createdAt, lookback) {
  for (const dateStr of clickDates(createdAt, lookback)) {
    const rows = await gadsQuery(token, `
      SELECT campaign.name, ad_group.name,
             click_view.keyword_info.text, click_view.keyword_info.match_type
      FROM click_view
      WHERE click_view.gclid = '${gclid}' AND segments.date = '${dateStr}'`);
    if (rows.length) {
      const r = rows[0];
      return {
        campaign:  r.campaign?.name    || '',
        adGroup:   r.adGroup?.name     || '',
        keyword:   r.clickView?.keywordInfo?.text || '',
        matchType: mapMatchType(r.clickView?.keywordInfo?.matchType)
      };
    }
  }
  return null;
}

// Candidate click dates: lead day first (most brand-search converts same
// day), then back a week, plus +1 for UTC/London midnight skew. Dates
// outside click_view's hard ~90-day window are dropped: querying one 400s
// (INVALID_ARGUMENT) rather than returning empty, so an old click (common
// on repeat-booking leads) must never reach the query. Empty list => the
// lead resolves to not-found.
function clickDates (createdAt, lookback) {
  const base  = new Date(createdAt || Date.now()).getTime();
  const now   = Date.now();
  const minMs = now - 90 * 86400000;
  const offsets = [0, -1, 1];
  for (let d = 2; d <= lookback; d++) offsets.push(-d);
  const out = [];
  for (const off of offsets) {
    const t = base + off * 86400000;
    if (t < minMs || t > now + 86400000) continue;
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// Match existing macro output ({matchtype} => e/p/b).
function mapMatchType (mt) {
  return { EXACT: 'e', PHRASE: 'p', BROAD: 'b' }[mt] || (mt ? String(mt).toLowerCase() : '');
}

async function writeColumns (itemId, cols) {
  // Drop empties so we never blank a field click_view didn't fill.
  const clean = {};
  Object.keys(cols).forEach(k => { if (cols[k]) clean[k] = cols[k]; });
  const mutation = `mutation {
    change_multiple_column_values(board_id: ${LEADS_BOARD}, item_id: ${itemId},
      column_values: ${JSON.stringify(JSON.stringify(clean))}) { id }
  }`;
  await mondayQuery(mutation);
}

// ── shared clients ─────────────────────────────────────────────
async function mondayQuery (query) {
  const r = await fetch(MONDAY_API, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
    body:    JSON.stringify({ query })
  });
  const d = await r.json();
  if (d.errors) throw new Error(JSON.stringify(d.errors).slice(0, 200));
  return d;
}

async function getAccessToken () {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Token failed: ' + JSON.stringify(d).slice(0, 200));
  return d.access_token;
}

async function gadsQuery (token, gaql) {
  const url = `https://googleads.googleapis.com/v21/customers/${CUSTOMER_ID}/googleAds:search`;
  const r = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization':     `Bearer ${token}`,
      'developer-token':   process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'login-customer-id': MCC_ID,
      'Content-Type':      'application/json'
    },
    body: JSON.stringify({ query: gaql })
  });
  const text = await r.text();
  if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) {
    throw new Error('GAds non-JSON: ' + text.slice(0, 160));
  }
  const data = JSON.parse(text);
  if (data.error) throw new Error('GAds: ' + JSON.stringify(data.error).slice(0, 200));
  return data.results || [];
}
