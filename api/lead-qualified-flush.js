// lead-qualified-flush.js
//
// Cron. Drains the Lead Qualified delay queue every 5 minutes.
//
// /api/lead-qualified-webhook parks each newly qualified lead with a due time
// of now + LEAD_QUALIFIED_DELAY_MINUTES (30 by default). This endpoint picks up
// everything past its due time, re-reads the lead from Monday, and sends the
// email. Re-reading is the point: the apartment chosen, the nightly rate
// agreed and the sales notes typed in the minutes after qualification are all
// in the email instead of arriving too late to matter.
//
// Manual triggers (need CRON_SECRET as ?secret= or a Bearer token):
//   GET /api/lead-qualified-flush?secret=...              send everything due
//   GET /api/lead-qualified-flush?secret=...&status=1     list the queue, send nothing
//   GET /api/lead-qualified-flush?secret=...&force=1      ignore due times, send all pending
//   GET /api/lead-qualified-flush?secret=...&dryRun=1     report what would send
//   GET /api/lead-qualified-flush?secret=...&itemId=123   send one lead now, queued or not
//   GET /api/lead-qualified-flush?secret=...&recent=3     resend the N most recently
//                                                         qualified leads to everyone
//
// itemId and recent are explicit operator actions, so they BYPASS the 24h
// dedupe guard: asking for a resend means you want the email again.

const { sendQualifiedEmail, fetchRecentQualified } = require('./_lead-qualified-data');
const { dueLeads, listPending, removeLead, claimSend, releaseSend, delayMinutes } = require('./_lead-qualified-queue');
const { logError } = require('./_errlog.js');

function recipients() {
  return (process.env.LEAD_QUALIFIED_TO || 'dana@studentluxe.co.uk, sam@studentluxe.co.uk, edoardo@studentluxe.co.uk, lina@studentluxe.co.uk, paige@studentluxe.co.uk, josh@studentluxe.co.uk, alex@studentluxe.co.uk')
    .split(',').map(s => s.trim()).filter(Boolean);
}

module.exports = async function handler(req, res) {
  const q = req.query || {};

  // Vercel cron sends Authorization: Bearer <CRON_SECRET>. Manual calls can
  // pass ?secret= instead. Same shape as replay-failed-events.
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (process.env.CRON_SECRET && q.secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const dryRun = String(q.dryRun || '') === '1';

    if (String(q.status || '') === '1') {
      return res.status(200).json({
        delayMinutes: delayMinutes(),
        pending:      await listPending()
      });
    }

    let queue;
    if (q.itemId) {
      queue = [{ pulseId: String(q.itemId), meta: {}, bypassDedupe: true }];
    } else if (q.recent) {
      const n = Math.min(10, Math.max(1, parseInt(q.recent, 10) || 1));
      const items = await fetchRecentQualified(n);
      queue = items.map(it => ({ pulseId: String(it.id), name: it.name, meta: {}, bypassDedupe: true }));
    } else if (String(q.force || '') === '1') {
      queue = (await listPending()).map(p => ({ pulseId: p.pulseId, meta: {} }));
    } else {
      queue = await dueLeads(50);
    }

    const results = [];

    for (const entry of queue) {
      const { pulseId, meta } = entry;

      if (dryRun) {
        results.push({ pulseId, name: entry.name, dryRun: true });
        continue;
      }

      // One send per lead, even if two cron runs overlap. An explicit
      // operator resend (itemId / recent) skips the guard on purpose.
      if (!entry.bypassDedupe) {
        const claimed = await claimSend(pulseId);
        if (!claimed) {
          await removeLead(pulseId);
          results.push({ pulseId, skipped: 'already sent recently' });
          continue;
        }
      }

      try {
        const out = await sendQualifiedEmail({
          pulseId,
          by:          meta.by,
          qualifiedAt: meta.qualifiedAt,
          to:          recipients()
        });

        if (out.sent) {
          await removeLead(pulseId);
          results.push({ pulseId, sent: true, resendId: out.resendId });
          console.log(`Lead Qualified email sent for item ${pulseId} to ${recipients().join(', ')}`);
        } else {
          // Deliberate no-send (unqualified again, item deleted). Drop it.
          await removeLead(pulseId);
          await releaseSend(pulseId);
          results.push({ pulseId, sent: false, reason: out.reason });
          console.log(`Lead ${pulseId} dropped from queue: ${out.reason}`);
        }
      } catch (err) {
        // Leave it queued so the next run retries, and un-claim so it can.
        await releaseSend(pulseId);
        results.push({ pulseId, error: err.message });
        console.error(`lead-qualified-flush failed for item ${pulseId}:`, err.message);
        await logError('lead-qualified-flush', err);
      }
    }

    return res.status(200).json({
      ok:      true,
      dryRun,
      checked: queue.length,
      sent:    results.filter(r => r.sent).length,
      results
    });

  } catch (err) {
    console.error('lead-qualified-flush error:', err);
    await logError('lead-qualified-flush', err);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
