// ============================================================
//  Performance Max review (weekly).
//  GET /api/pmax-review?secret=<CRON_SECRET>[&days=14&minSpend=40&minClicks=30&dryRun=1]
//
//  Google gives Performance Max no per-click keyword, so the usual "which
//  term produced this lead" reading is impossible. What it does give is
//  campaign, asset group and search category aggregates. This report joins
//  those to what Monday actually saw (leads, junk reasons, high potential,
//  bookings) and flags the pieces that spend without producing:
//
//    - Asset groups: spend or clicks over the threshold, zero Step 1
//      conversions in the window. Candidates to pause or rebuild.
//    - Search categories: Google's own query themes for each campaign
//      (campaign_search_term_insight), clicks over the threshold with no
//      conversions. Candidates for campaign-level negative keywords.
//    - Campaign scoreboard: Google's cost and conversions by step against
//      Monday's lead count, junk count and confirmed bookings, so the one
//      campaign that books is visible next to the ones that only enquire.
//
//  Channel split (Search vs Display vs Video inside a Perf Max campaign) is
//  not exposed by the API, only in the Ads UI, so it is not attempted here.
//
//  Handover: ?section=1 stashes the card in KV for the combined weekly
//  report (?cached=1 serves it back), mirroring gads-dissonance.
// ============================================================

const MONDAY_API  = 'https://api.monday.com/v2';
const LEADS_BOARD = 2171015719;
const CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
const MCC_ID      = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '6046238343';
const SECTION_KEY = 'digest:pmax';

const { shell, table, th, td, emptyRow, esc, sendDigest, BRAND } = require('./_digest.js');
const { logError } = require('./_errlog.js');

// Conversion action names as they appear in segments.conversion_action_name.
// Matched loosely so a rename in the Ads UI does not silently drop a column.
const STEP_MATCH = [
  { key: 'step1', label: 'Step 1', re: /step\s*1|new\s*enquir|lead/i },
  { key: 'step2', label: 'Step 2', re: /step\s*2|moderate/i },
  { key: 'step3', label: 'Step 3', re: /step\s*3|high\s*potential/i },
  { key: 'step4', label: 'Step 4', re: /step\s*4|booking|confirmed/i }
];

module.exports = async function handler (req, res) {
  const bearer   = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const digestOk = process.env.DIGEST_TOKEN && bearer === process.env.DIGEST_TOKEN;
  if (req.query?.secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET && !digestOk) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (req.query?.cached === '1') {
    const cached = await readSection();
    return res.status(200).json(cached || { title: 'Performance Max review', empty: true });
  }

  const days      = Math.max(1, Math.min(90, parseInt(req.query?.days || '14', 10)));
  const minSpend  = Math.max(0, parseFloat(req.query?.minSpend  || '40'));
  const minClicks = Math.max(0, parseInt(req.query?.minClicks || '30', 10));
  const dryRun    = req.query?.dryRun === '1';
  const untilMs   = Date.now();
  const sinceMs   = untilMs - days * 86400000;
  const sinceIso  = new Date(sinceMs).toISOString().slice(0, 10);
  const untilIso  = new Date(untilMs).toISOString().slice(0, 10);

  try {
    if (!CUSTOMER_ID) throw new Error('GOOGLE_ADS_CUSTOMER_ID missing');
    const token = await getAccessToken();

    const [campaigns, assetGroups, stepsByCampaign, leads] = await Promise.all([
      fetchCampaigns(token, sinceIso, untilIso),
      fetchAssetGroups(token, sinceIso, untilIso),
      fetchStepBreakdown(token, sinceIso, untilIso),
      fetchPpcLeads(sinceMs)
    ]);

    // Search categories are one query per campaign; only campaigns that
    // actually spent in the window earn the call.
    const categories = [];
    for (const c of campaigns.filter(c => c.cost > 0)) {
      try {
        const rows = await fetchSearchCategories(token, c.id, sinceIso, untilIso);
        rows.forEach(r => categories.push({ ...r, campaign: c.name, campaignId: c.id }));
      } catch (e) {
        console.warn(`pmax-review: search categories failed for ${c.name}:`, e.message);
      }
    }

    const out = analyse({ campaigns, assetGroups, stepsByCampaign, leads, categories, minSpend, minClicks, days });

    if (req.query?.section === '1') {
      const section = pmaxSection(out, days);
      await stashSection(section).catch(e => console.warn('pmax stash failed:', e.message));
      return res.status(200).json(section);
    }

    const section = pmaxSection(out, days);
    const html = shell({
      eyebrow:  'Student Luxe',
      title:    section.empty ? 'Performance Max review, nothing to flag' : `Performance Max review, ${section.stat}`,
      subtitle: `Last ${days} days · spend threshold £${minSpend} · click threshold ${minClicks}`,
      sections: [section],
      footer:   'Weekly Performance Max review (/api/pmax-review). Google exposes no per-click keyword for Performance Max; search categories are Google&#39;s own query themes per campaign. Asset groups and categories are flagged when they clear the threshold with no conversions in the window. Review before pausing: a 14 day window is short for a 248 night booking cycle.'
    });

    if (dryRun) return res.status(200).json({ dryRun: true, days, minSpend, minClicks, out, subject: subjectFor(section, days), html });

    await sendDigest({ subject: subjectFor(section, days), html });
    return res.status(200).json({ sent: true, subject: subjectFor(section, days), flagged: out.flaggedAssetGroups.length + out.flaggedCategories.length });

  } catch (err) {
    console.error('pmax-review error:', err.message);
    await logError('pmax-review', err);
    return res.status(500).json({ error: err.message });
  }
};

function subjectFor (section, days) {
  return section.empty
    ? `Perf Max review: nothing to flag (last ${days}d)`
    : `Perf Max review: ${section.stat} (last ${days}d)`;
}

// ── Analysis ───────────────────────────────────────────────────
function analyse ({ campaigns, assetGroups, stepsByCampaign, leads, categories, minSpend, minClicks, days }) {
  // Monday leads keyed by the campaign name the lead carried. Last-touch
  // campaign first, first-touch as fallback so an enriched-later lead still
  // lands somewhere.
  const mondayByCampaign = {};
  for (const l of leads) {
    const key = norm(l.campaign || l.firstCampaign);
    if (!key) continue;
    const m = mondayByCampaign[key] = mondayByCampaign[key] || { leads: 0, junk: 0, highPotential: 0, booked: 0 };
    m.leads++;
    if (l.junk) m.junk++;
    if (/high potential/i.test(l.potential)) m.highPotential++;
    if (/confirmed|booked/i.test(l.status)) m.booked++;
  }

  const scoreboard = campaigns.map(c => {
    const steps = stepsByCampaign[c.id] || {};
    const m = mondayByCampaign[norm(c.name)] || { leads: 0, junk: 0, highPotential: 0, booked: 0 };
    return {
      id: c.id, name: c.name, status: c.status, bidding: c.bidding,
      cost: c.cost, clicks: c.clicks, impressions: c.impressions,
      conv: c.conv, convValue: c.convValue,
      step1: steps.step1 || 0, step2: steps.step2 || 0, step3: steps.step3 || 0, step4: steps.step4 || 0,
      step4Value: steps.step4Value || 0,
      mondayLeads: m.leads, mondayJunk: m.junk, mondayHP: m.highPotential, mondayBooked: m.booked,
      cpl: m.leads > 0 ? c.cost / m.leads : null
    };
  }).sort((a, b) => b.cost - a.cost);

  // Asset groups that spend without a single Step 1. metrics.conversions on
  // asset_group counts primary actions, which is Step 1 for this account;
  // a group with any conversions is left alone.
  const flaggedAssetGroups = assetGroups
    .filter(g => g.status === 'ENABLED')
    .filter(g => (g.cost >= minSpend || g.clicks >= minClicks) && g.conv === 0)
    .sort((a, b) => b.cost - a.cost);

  // Search categories with clicks and no conversions. These are Google's
  // query themes, so a flagged row is a negative keyword candidate, not a
  // literal search term.
  const flaggedCategories = categories
    .filter(r => r.clicks >= minClicks && r.conv === 0)
    .sort((a, b) => b.clicks - a.clicks);

  // Where the bookings are: campaigns with a Step 4 or a Monday confirmed
  // booking in the window, so the winner stays in view next to the flags.
  const bookers = scoreboard.filter(c => c.step4 > 0 || c.mondayBooked > 0);

  const totalCost = campaigns.reduce((s, c) => s + c.cost, 0);
  const wastedCost = flaggedAssetGroups.reduce((s, g) => s + g.cost, 0);

  return { days, scoreboard, flaggedAssetGroups, flaggedCategories, bookers, totalCost, wastedCost,
           leadCount: leads.length, campaignCount: campaigns.length, categoryCount: categories.length };
}

function norm (s) { return (s || '').trim().toLowerCase(); }

// ── Digest section ─────────────────────────────────────────────
function pmaxSection (out, days) {
  const gbp = n => '£' + Math.round(n).toLocaleString('en-GB');
  const num = n => Number(n || 0).toLocaleString('en-GB', { maximumFractionDigits: 1 });
  const flagged = out.flaggedAssetGroups.length + out.flaggedCategories.length;

  if (!out.campaignCount) {
    return { title: 'Performance Max review', stat: 'no Perf Max campaigns', tone: 'plain', empty: true };
  }

  const scoreRows = out.scoreboard.map(c => {
    const winner = c.step4 > 0 || c.mondayBooked > 0;
    return `<tr style="background:${winner ? '#f2f8f4' : ''};">
      ${td(esc(c.name) + (c.status !== 'ENABLED' ? ` <span style="color:${BRAND.muted};font-size:10.5px;">(${esc(c.status.toLowerCase())})</span>` : ''))}
      ${td(gbp(c.cost), 'right')}
      ${td(String(c.clicks), 'right')}
      ${td(num(c.step1), 'right')}
      ${td(num(c.step3), 'right')}
      ${td(num(c.step4) + (c.step4Value ? ` <span style="color:${BRAND.muted};font-size:10.5px;">${gbp(c.step4Value)}</span>` : ''), 'right', winner ? `color:${BRAND.green};font-weight:600;` : '')}
      ${td(String(c.mondayLeads) + (c.mondayJunk ? ` <span style="color:${BRAND.red};font-size:10.5px;">${c.mondayJunk} junk</span>` : ''), 'right')}
      ${td(c.cpl != null ? gbp(c.cpl) : '&mdash;', 'right')}
    </tr>`;
  }).join('');

  const scoreboard = `
    <p style="margin:0 0 8px;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.gold};">Campaign scoreboard</p>
    ${table(th('Campaign') + th('Cost', 'right') + th('Clicks', 'right') + th('Step 1', 'right') + th('Step 3', 'right') + th('Step 4', 'right') + th('Monday leads', 'right') + th('Cost / lead', 'right'), scoreRows)}
    <div style="margin-top:8px;font-size:11px;color:${BRAND.muted};line-height:1.55;">
      Steps are Google&#39;s attributed conversions by click date. Monday leads are PPC leads created in the window whose campaign column matches, with Budget too low and Spam counted as junk. Green rows booked.
    </div>`;

  const agRows = out.flaggedAssetGroups.map(g => `<tr>
      ${td(esc(g.campaign))}
      ${td(esc(g.name))}
      ${td(gbp(g.cost), 'right', `color:${BRAND.red};font-weight:600;`)}
      ${td(String(g.clicks), 'right')}
      ${td(String(g.impressions), 'right')}
      ${td('0', 'right')}
    </tr>`).join('');

  const assetGroups = `
    <p style="margin:18px 0 8px;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${out.flaggedAssetGroups.length ? BRAND.red : BRAND.gold};">Asset groups spending with no Step 1</p>
    ${table(th('Campaign') + th('Asset group') + th('Cost', 'right') + th('Clicks', 'right') + th('Impr.', 'right') + th('Conv.', 'right'),
            agRows || emptyRow(6, 'Every asset group over the threshold produced at least one conversion.'))}`;

  const catRows = out.flaggedCategories.map(r => `<tr>
      ${td(esc(r.campaign))}
      ${td(esc(r.label))}
      ${td(String(r.clicks), 'right', `color:${BRAND.red};font-weight:600;`)}
      ${td(String(r.impressions), 'right')}
      ${td('0', 'right')}
    </tr>`).join('');

  const categories = `
    <p style="margin:18px 0 8px;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${out.flaggedCategories.length ? BRAND.red : BRAND.gold};">Search categories clicking with no conversions</p>
    ${table(th('Campaign') + th('Search category') + th('Clicks', 'right') + th('Impr.', 'right') + th('Conv.', 'right'),
            catRows || emptyRow(5, out.categoryCount ? 'Every category over the threshold converted at least once.' : 'Google returned no search category data for this window.'))}
    <div style="margin-top:8px;font-size:11px;color:${BRAND.muted};line-height:1.55;">
      Categories are Google&#39;s query themes, the only search term data Performance Max exposes. A flagged row is a campaign-level negative keyword candidate. Check it in the Ads UI (Insights, Search terms) before adding the negative.
    </div>`;

  const stat = flagged
    ? `${out.flaggedAssetGroups.length} asset group${out.flaggedAssetGroups.length === 1 ? '' : 's'}, ${out.flaggedCategories.length} categor${out.flaggedCategories.length === 1 ? 'y' : 'ies'} flagged`
    : `${gbp(out.totalCost)} spend, nothing to flag`;

  return {
    title: 'Performance Max review',
    stat,
    tone: flagged ? 'warn' : 'good',
    subtitle: `Last ${days} days · ${gbp(out.totalCost)} across ${out.campaignCount} campaign${out.campaignCount === 1 ? '' : 's'}${out.wastedCost ? ` · ${gbp(out.wastedCost)} in flagged asset groups` : ''}`,
    html: scoreboard + assetGroups + categories
  };
}

// ── Google Ads ─────────────────────────────────────────────────
async function getAccessToken () {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_ADS_CLIENT_ID, client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET, refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
  const d = await r.json();
  if (!d.access_token) throw new Error('Token failed: ' + JSON.stringify(d).slice(0, 160));
  return d.access_token;
}

async function gadsQuery (token, gaql) {
  const r = await fetch(`https://googleads.googleapis.com/v24/customers/${CUSTOMER_ID}/googleAds:search`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN, 'login-customer-id': MCC_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gaql }) });
  const text = await r.text();
  if (!text.trim().startsWith('{')) throw new Error('GAds non-JSON: ' + text.slice(0, 120));
  const data = JSON.parse(text);
  if (data.error) throw new Error('GAds: ' + JSON.stringify(data.error).slice(0, 200));
  return data.results || [];
}

const micros = v => Number(v || 0) / 1e6;

async function fetchCampaigns (token, sinceIso, untilIso) {
  const rows = await gadsQuery(token, `
    SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type,
           metrics.clicks, metrics.impressions, metrics.cost_micros,
           metrics.conversions, metrics.conversions_value
    FROM campaign
    WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX'
      AND campaign.status != 'REMOVED'
      AND segments.date BETWEEN '${sinceIso}' AND '${untilIso}'`);
  return rows.map(r => ({
    id: String(r.campaign?.id || ''), name: r.campaign?.name || '', status: r.campaign?.status || '',
    bidding: r.campaign?.biddingStrategyType || '',
    clicks: Number(r.metrics?.clicks || 0), impressions: Number(r.metrics?.impressions || 0),
    cost: micros(r.metrics?.costMicros), conv: Number(r.metrics?.conversions || 0),
    convValue: Number(r.metrics?.conversionsValue || 0)
  }));
}

async function fetchAssetGroups (token, sinceIso, untilIso) {
  const rows = await gadsQuery(token, `
    SELECT campaign.id, campaign.name, asset_group.id, asset_group.name, asset_group.status,
           metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions
    FROM asset_group
    WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX'
      AND asset_group.status != 'REMOVED'
      AND segments.date BETWEEN '${sinceIso}' AND '${untilIso}'`);
  return rows.map(r => ({
    campaignId: String(r.campaign?.id || ''), campaign: r.campaign?.name || '',
    id: String(r.assetGroup?.id || ''), name: r.assetGroup?.name || '', status: r.assetGroup?.status || '',
    clicks: Number(r.metrics?.clicks || 0), impressions: Number(r.metrics?.impressions || 0),
    cost: micros(r.metrics?.costMicros), conv: Number(r.metrics?.conversions || 0)
  }));
}

// Conversions by action name per campaign, so Step 1 to 4 sit side by side.
async function fetchStepBreakdown (token, sinceIso, untilIso) {
  const rows = await gadsQuery(token, `
    SELECT campaign.id, segments.conversion_action_name,
           metrics.all_conversions, metrics.all_conversions_value
    FROM campaign
    WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX'
      AND segments.date BETWEEN '${sinceIso}' AND '${untilIso}'`);
  const by = {};
  for (const r of rows) {
    const id   = String(r.campaign?.id || '');
    const name = r.segments?.conversionActionName || '';
    const step = STEP_MATCH.find(s => s.re.test(name));
    if (!step) continue;
    const b = by[id] = by[id] || {};
    b[step.key] = (b[step.key] || 0) + Number(r.metrics?.allConversions || 0);
    if (step.key === 'step4') b.step4Value = (b.step4Value || 0) + Number(r.metrics?.allConversionsValue || 0);
  }
  return by;
}

// Google's query themes for one Performance Max campaign. The resource
// insists on a campaign_id filter and a date range.
async function fetchSearchCategories (token, campaignId, sinceIso, untilIso) {
  const rows = await gadsQuery(token, `
    SELECT campaign_search_term_insight.id, campaign_search_term_insight.category_label,
           metrics.clicks, metrics.impressions, metrics.conversions
    FROM campaign_search_term_insight
    WHERE campaign_search_term_insight.campaign_id = ${campaignId}
      AND segments.date BETWEEN '${sinceIso}' AND '${untilIso}'`);
  return rows.map(r => ({
    id: String(r.campaignSearchTermInsight?.id || ''),
    label: r.campaignSearchTermInsight?.categoryLabel || '(unlabelled)',
    clicks: Number(r.metrics?.clicks || 0), impressions: Number(r.metrics?.impressions || 0),
    conv: Number(r.metrics?.conversions || 0)
  }));
}

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

// PPC leads created in the window, newest first, stopping at the floor.
async function fetchPpcLeads (sinceMs) {
  const COLS = '["text_mm1c3b5w","text_mm4ntp4n","status_11","color_mkt29g1r","status","color_mkxk8y67"]';
  const leads = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const q = cursor
      ? `query { next_items_page(limit: 100, cursor: ${JSON.stringify(cursor)}) { cursor items { id created_at column_values(ids: ${COLS}) { id text } } } }`
      : `query { boards(ids: ${LEADS_BOARD}) { items_page(limit: 100, query_params: {
           rules: [{ column_id: "color_mkxk8y67", compare_value: ["PPC"], operator: contains_text }],
           order_by: [{ column_id: "__creation_log__", direction: desc }]
         }) { cursor items { id created_at column_values(ids: ${COLS}) { id text } } } } }`;
    const d    = await mondayQuery(q);
    const pg   = cursor ? d?.data?.next_items_page : d?.data?.boards?.[0]?.items_page;
    if (!pg) break;
    let hitFloor = false;
    for (const it of (pg.items || [])) {
      if (new Date(it.created_at || 0).getTime() < sinceMs) { hitFloor = true; break; }
      const c = {};
      it.column_values.forEach(x => { c[x.id] = (x.text || '').trim(); });
      leads.push({
        id: it.id, createdAt: it.created_at,
        campaign: c.text_mm1c3b5w, firstCampaign: c.text_mm4ntp4n,
        potential: c.color_mkt29g1r, status: c.status,
        junk: /budget too low|spam/i.test(c.status_11 || '')
      });
    }
    cursor = pg.cursor;
    if (hitFloor || !cursor) break;
  }
  return leads;
}

// ── Digest handover ────────────────────────────────────────────
let _kv = null;
async function digestKv () {
  if (_kv) return _kv;
  const { Redis } = await import('@upstash/redis');
  _kv = Redis.fromEnv();
  return _kv;
}
async function stashSection (section) {
  await (await digestKv()).set(SECTION_KEY, { at: Date.now(), section }, { ex: 9 * 24 * 3600 });
}
async function readSection () {
  try {
    const stored = await (await digestKv()).get(SECTION_KEY);
    if (!stored?.at || Date.now() - stored.at > 8 * 24 * 3600 * 1000) return null;
    return stored.section;
  } catch { return null; }
}

module.exports.analyse = analyse;
module.exports.pmaxSection = pmaxSection;
