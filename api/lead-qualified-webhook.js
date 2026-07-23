// lead-qualified-webhook.js
//
// LIVE endpoint. Monday calls this when a lead's status changes to Qualified.
// It builds the redesigned "Lead Qualified" email from the item's real data and
// sends it to senior staff via Resend. Replaces the old Monday email automation.
//
// Setup (see also the README):
//   1. Deploy, set MONDAY_API_KEY, RESEND_API_KEY, LEAD_QUALIFIED_TO in Vercel.
//   2. On the Monday Leads board, add an automation:
//        "When Status changes to Qualified, send a webhook to
//         https://luxe-lead-capture.vercel.app/api/lead-qualified-webhook"
//   3. Turn off the old qualified-lead email automation.
//
// Recipients: LEAD_QUALIFIED_TO (comma-separated). Falls back to alex@studentluxe.co.uk.

const { renderLeadQualified } = require('./_lead-qualified-email');
const { fetchItem, fetchTimeline, resolveUserName, mapItemToLead, sendEmail } = require('./_lead-qualified-data');

function recipients() {
  return (process.env.LEAD_QUALIFIED_TO || 'alex@studentluxe.co.uk, sam@studentluxe.co.uk, josh@studentluxe.co.uk')
    .split(',').map(s => s.trim()).filter(Boolean);
}

// Names whose qualifications should NOT trigger an email (e.g. CRM testers).
// Comma-separated, configurable via LEAD_QUALIFIED_SUPPRESS.
function isSuppressed(name) {
  if (!name) return false;
  const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const list = (process.env.LEAD_QUALIFIED_SUPPRESS || 'Dana W Danan')
    .split(',').map(norm).filter(Boolean);
  return list.includes(norm(name));
}

const { logError } = require('./_errlog.js');

module.exports = async function handler(req, res) {
  try {
    // Health check / accidental browser hit.
    if (req.method === 'GET') {
      return res.status(200).send('lead-qualified-webhook is live. Monday should POST here.');
    }
    if (req.method !== 'POST') {
      return res.status(405).send('Method not allowed');
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    // Monday verification handshake when the webhook is first registered.
    if (body.challenge) {
      return res.status(200).json({ challenge: body.challenge });
    }

    const event = body.event || {};
    const pulseId = event.pulseId || event.itemId || body.pulseId;
    if (!pulseId) {
      // Nothing actionable; ack so Monday does not retry.
      return res.status(200).json({ ignored: 'no pulseId in payload' });
    }

    // If the payload tells us the new status, make sure it is Qualified.
    const newLabel = (event.value && (event.value.label?.text || event.value.label)) || '';
    // Anchored: "Qualified Lead" passes, "Unqualified Lead" must not.
    if (newLabel && !/^\s*qualif/i.test(String(newLabel))) {
      return res.status(200).json({ ignored: `status is "${newLabel}", not Qualified` });
    }

    // Skip qualifications made by CRM testers (e.g. Dana W Danan).
    const by = await resolveUserName(event.userId);
    if (isSuppressed(by)) {
      console.log(`Suppressed qualified-lead email for item ${pulseId}: qualified by ${by}`);
      return res.status(200).json({ ignored: `qualified by suppressed user "${by}"` });
    }

    const item = await fetchItem(pulseId);
    if (!item) {
      return res.status(200).json({ ignored: `item ${pulseId} not found` });
    }

    const lead = mapItemToLead(item, {
      by:          by || undefined,             // who changed the status
      qualifiedAt: event.triggerTime || undefined
    });
    lead.timeline = await fetchTimeline(item.id, item.created_at);

    const { subject, html } = renderLeadQualified(lead);
    const sent = await sendEmail({ to: recipients(), subject, html });

    console.log(`Lead Qualified email sent for item ${pulseId} to ${recipients().join(', ')}`);
    return res.status(200).json({ ok: true, itemId: String(pulseId), resendId: sent.id || null });

  } catch (err) {
    console.error('lead-qualified-webhook error:', err);
    await logError('lead-qualified-webhook', err);
    // Return 200 so Monday does not hammer retries on a transient failure;
    // the error is logged for inspection.
    return res.status(200).json({ ok: false, error: err.message });
  }
};
