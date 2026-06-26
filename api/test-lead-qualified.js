// test-lead-qualified.js
//
// Preview / test harness for the redesigned "Lead Qualified" staff email,
// using REAL data from the Monday Leads board. Shares all Monday/mapping
// logic with the live webhook via _lead-qualified-data.js.
//
// Usage (after deploy, with MONDAY_API_KEY set in Vercel):
//   GET /api/test-lead-qualified?itemId=123456789
//        -> renders the email for that lead and returns the HTML (view in browser)
//   GET /api/test-lead-qualified
//        -> auto-picks the most recently updated lead whose status is Qualified
//   GET /api/test-lead-qualified?itemId=123&send=you@studentluxe.co.uk
//        -> also sends a real test email via Resend (subject prefixed [TEST])
//
// Optional overrides (the live webhook supplies these from the trigger):
//   &by=Sofia%20Marchetti               who qualified it (default: the assignee)
//   &qualifiedAt=2026-06-26T14:32:00Z   default: the item's updated_at

const { renderLeadQualified } = require('./_lead-qualified-email');
const { fetchItem, fetchLatestQualified, mapItemToLead, sendEmail } = require('./_lead-qualified-data');

module.exports = async function handler(req, res) {
  try {
    if (!process.env.MONDAY_API_KEY) {
      return res.status(500).send('MONDAY_API_KEY is not set');
    }

    const q = req.query || {};

    // Optional guard: if TEST_ENDPOINT_KEY is set in Vercel, require ?key= to match.
    if (process.env.TEST_ENDPOINT_KEY && q.key !== process.env.TEST_ENDPOINT_KEY) {
      return res.status(401).send('Unauthorized');
    }

    const item = q.itemId ? await fetchItem(q.itemId) : await fetchLatestQualified();
    if (!item) {
      return res.status(404).send(q.itemId
        ? `No Monday item found for id ${q.itemId}`
        : 'No lead with status "Qualified" found on the board');
    }

    const lead = mapItemToLead(item, { by: q.by, qualifiedAt: q.qualifiedAt, createdAt: q.createdAt });
    const { subject, html } = renderLeadQualified(lead);

    let sent = null;
    if (q.send) {
      sent = await sendEmail({ to: q.send, subject, html, testPrefix: true });
    }

    // Header values must be ASCII, so the subject (checkmark + middle dots) is
    // URI-encoded; the full subject is in the email's title.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Lead-Item-Id', String(item.id));
    res.setHeader('X-Email-Subject', encodeURIComponent(subject));
    if (sent) res.setHeader('X-Resend-Id', String(sent.id || 'sent'));
    return res.status(200).send(html);

  } catch (err) {
    console.error('test-lead-qualified error:', err);
    return res.status(500).send('Error: ' + err.message);
  }
};
