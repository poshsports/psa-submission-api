// api/admin/cards.set-status.js
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '../_util/adminAuth.js';

const POST_PSA_STATUSES = [
  'received_from_psa',
  'balance_due',
  'paid',
  'shipped_to_customer',
  'delivered',
];
const POST_PSA_SET = new Set(POST_PSA_STATUSES);
const RANK = POST_PSA_STATUSES.reduce((m, v, i) => ((m[v] = i), m), {});

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

// Resolve envs in a way that matches your existing project:
//  - prefer lower-case `supabaseUrl` / `supabaseKey`
//  - fall back to SUPABASE_URL / SUPABASE_SERVICE_ROLE (or SERVICE_KEY)
function getAdminClient() {
  const url =
    process.env.supabaseUrl ||
    process.env.SUPABASE_URL;

  const key =
    process.env.supabaseKey ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.supabaseServiceKey;

  if (!url) throw new Error('supabaseUrl/SUPABASE_URL is required.');
  if (!key) throw new Error('supabaseKey/SUPABASE_SERVICE_ROLE is required.');

  return createClient(url, key, { auth: { persistSession: false } });
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
    if (!authed) return;

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

    const supabase = getAdminClient();

    // 1) Update the card status
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

    // 2) Bubble the parent submission status forward so the User Portal
    //    (which reads `submissions.status`) reflects the latest card status.
    let bubbledTo = null;
    try {
      const submissionId = updated?.submission_id && String(updated.submission_id);
      if (submissionId) {
        const { data: sub, error: subErr } = await supabase
          .from('submissions')
          .select('id, status')
          .eq('id', submissionId)
          .single();

        if (!subErr && sub) {
          const curRank = RANK[String(sub.status || '').toLowerCase()] ?? -1;

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
              if (rk != null && rk > maxRank) { maxRank = rk; maxVal = v; }
            }
            if (maxVal && maxRank > curRank) {
              const { error: upErr } = await supabase
                .from('submissions')
                .update({ status: maxVal })
                .eq('id', submissionId);
              if (!upErr) bubbledTo = maxVal;
            }
          }
        }
      }
    } catch { /* keep non-fatal */ }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, updated: 1, bubbled_submission_to: bubbledTo }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err?.message || 'server_error' }));
  }
}
