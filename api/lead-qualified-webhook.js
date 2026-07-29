// lead-qualified-webhook.js
//
// LIVE endpoint. Monday calls this when a lead's status changes to Qualified.
//
// It does NOT send the email straight away. The salesperson keeps adding data
// for 5 to 15 minutes after they flip the status (apartment chosen, nightly
// rate agreed, notes), so the lead is parked in a Redis delay queue and
// /api/lead-qualified-flush sends it LEAD_QUALIFIED_DELAY_MINUTES later,
// re-reading Monday at that point so the email carries the full picture.
//
// Set LEAD_QUALIFIED_DELAY_MINUTES=0 to restore instant sending.
// POST with ?now=1 also bypasses the delay (useful for testing).
//
// Setup (see also the README):
//   1. Deploy, set MONDAY_API_KEY, RESEND_API_KEY, LEAD_QUALIFIED_TO in Vercel.
//   2. On the Monday Leads board, add an automation:
//        "When Status changes to Qualified, send a webhook to
//         https://luxe-lead-capture.vercel.app/api/lead-qualified-webhook"
//   3. Turn off the old qualified-lead email automation.
//
// Recipients: LEAD_QUALIFIED_TO (comma-separated). Falls back to alex@studentluxe.co.uk.

const { resolveUserName, sendQualifiedEmail } = require('./_lead-qualified-data');
const { enqueueLead, claimSend, releaseSend, delayMinutes } = require('./_lead-qualified-queue');

function recipients() {
  return (process.env.LEAD_QUALIFIED_TO || 'dana@studentluxe.co.uk, sam@studentluxe.co.uk, edoardo@studentluxe.co.uk, lina@studentluxe.co.uk, paige@studentluxe.co.uk, josh@studentluxe.co.uk, alex@studentluxe.co.uk')
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

    const qualifiedAt = event.triggerTime || new Date().toISOString();
    const immediate   = String(req.query?.now || '') === '1' || delayMinutes() === 0;

    // ── DELAYED PATH (default) ────────────────────────────────
    if (!immediate) {
      const q = await enqueueLead({ pulseId, by, qualifiedAt });
      if (q.queued) {
        console.log(`Lead ${pulseId} queued for Lead Qualified email at ${new Date(q.dueAt).toISOString()}` +
                    (q.alreadyQueued ? ' (already queued, kept the earlier due time)' : ''));
        return res.status(200).json({
          ok: true, queued: true, itemId: String(pulseId),
          dueAt: new Date(q.dueAt).toISOString(), alreadyQueued: !!q.alreadyQueued
        });
      }
      // Redis is down. Never lose the email: fall through and send now.
      console.warn(`Queue unavailable for item ${pulseId} (${q.reason}), sending immediately`);
    }

    // ── IMMEDIATE PATH ────────────────────────────────────────
    // Claim first so the flush cron cannot also send this one.
    const claimed = await claimSend(pulseId);
    if (!claimed) {
      return res.status(200).json({ ok: true, itemId: String(pulseId), ignored: 'already sent recently' });
    }

    let result;
    try {
      result = await sendQualifiedEmail({ pulseId, by, qualifiedAt, to: recipients() });
    } catch (sendErr) {
      await releaseSend(pulseId);   // let a retry through
      throw sendErr;
    }

    if (!result.sent) {
      await releaseSend(pulseId);
      return res.status(200).json({ ok: true, itemId: String(pulseId), ignored: result.reason });
    }

    console.log(`Lead Qualified email sent for item ${pulseId} to ${recipients().join(', ')}`);
    return res.status(200).json({ ok: true, itemId: String(pulseId), resendId: result.resendId });

  } catch (err) {
    console.error('lead-qualified-webhook error:', err);
    await logError('lead-qualified-webhook', err);
    // Return 200 so Monday does not hammer retries on a transient failure;
    // the error is logged for inspection.
    return res.status(200).json({ ok: false, error: err.message });
  }
};
