// api/admin/cards.set-status.js
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '../_util/adminAuth.js';

// Post-PSA statuses we allow on individual cards
const POST_PSA_STATUSES = [
  'received_from_psa',
  'balance_due',
  'paid',
  'shipped_to_customer',
  'delivered',
];
const POST_PSA_SET = new Set(POST_PSA_STATUSES);

// Order matters when we "bubble up" the submission status to keep the
// Shopify User Portal (which reads `submissions.status`) in sync.
const RANK = POST_PSA_STATUSES.reduce((m, v, i) => (m[v] = i, m), {});

// Small helper to safely read JSON body in Vercel/Node
function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({}); }
    });
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
      return;
    }

    // admin gate
    const authed = await requireAdmin(req, res);
    if (!authed) return; // requireAdmin already sent the response

    const { card_id, status } = await parseBody(req);
    const to = String(status || '').toLowerCase().trim();
    const id = String(card_id || '').trim();

    if (!id) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'missing_card_id' }));
      return;
    }
    if (!POST_PSA_SET.has(to)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'invalid_status' }));
      return;
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE
    );

    // 1) Update the card
    const { data: updated, error } = await supabase
      .from('submission_cards')
      .update({ status: to })
      .eq('id', id)
      .select('id, submission_id')
      .single();

    if (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: error.message }));
      return;
    }

    // 2) Auto-bubble the parent submission status forward so the User Portal
    //    (which shows `submissions.status`) reflects the latest per-card changes.
    //    We only ever move FORWARD within post-PSA statuses; we never roll back.
    let bubbledTo = null;
    try {
      const submissionId = updated?.submission_id && String(updated.submission_id);

      if (submissionId) {
        // Get the current submission status
        const { data: subRow, error: subErr } = await supabase
          .from('submissions')
          .select('id, status')
          .eq('id', submissionId)
          .single();

        if (!subErr && subRow) {
          const cur = String(subRow.status || '').toLowerCase();
          const curRank = RANK[cur] ?? -1;

          // Compute the "max" card status across this submission
          const { data: cardRows, error: crErr } = await supabase
            .from('submission_cards')
            .select('status')
            .eq('submission_id', submissionId);

          if (!crErr && Array.isArray(cardRows)) {
            let maxRank = -1;
            let maxVal = null;
            for (const r of cardRows) {
              const v = String(r.status || '').toLowerCase();
              const rk = RANK[v];
              if (rk != null && rk > maxRank) {
                maxRank = rk;
                maxVal = v;
              }
            }

            // Only move forward inside the post-PSA set
            if (maxVal && maxRank != null && maxRank > curRank) {
              const { error: upErr } = await supabase
                .from('submissions')
                .update({ status: maxVal })
                .eq('id', submissionId);
              if (!upErr) bubbledTo = maxVal;
            }
          }
        }
      }
    } catch { /* non-fatal; we still updated the card */ }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true,
      updated: 1,
      bubbled_submission_to: bubbledTo,
    }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err?.message || 'server_error' }));
  }
}
