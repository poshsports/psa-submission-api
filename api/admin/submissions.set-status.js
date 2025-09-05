// api/admin/submissions.set-status.js
// Advance ONE submission's status (forward-only) and cascade to its cards.

import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '../_util/adminAuth.js';

const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SERVICE_ROLE_KEY; // fallback if your env uses *_KEY

const ALLOWED = new Set([
  // pre/mid PSA
  'pending_payment','submitted','submitted_paid','received',
  'shipped_to_psa','in_grading','graded','shipped_back_to_us',
  // post PSA (user-facing)
  'received_from_psa','balance_due','paid','shipped_to_customer','delivered',
]);

const RANK = {
  pending_payment:0, submitted:1, submitted_paid:2, received:3,
  shipped_to_psa:4, in_grading:5, graded:6, shipped_back_to_us:7,
  received_from_psa:8, balance_due:9, paid:10, shipped_to_customer:11, delivered:12,
};

async function readJson(req){
  if (req.body) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch {} }
    if (typeof req.body === 'object') return req.body;
  }
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { return {}; }
}

export default async function handler(req, res){
  try {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'method_not_allowed' }));
      return;
    }

    // Admin gate
    const authed = await requireAdmin(req, res);
    if (!authed) return;

    if (!process.env.SUPABASE_URL || !SERVICE_ROLE) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'server_misconfigured' }));
      return;
    }

    const { submission_id, id, status, cascade_cards = true } = await readJson(req);
    const target = String(submission_id ?? id ?? '').trim();
    const to = String(status || '').trim().toLowerCase();

    if (!target) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'missing_submission_id' }));
      return;
    }
    if (!ALLOWED.has(to)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'invalid_status' }));
      return;
    }

    const supabase = createClient(process.env.SUPABASE_URL, SERVICE_ROLE);

    // Look up submission by numeric id OR code (psa-###)
    const isCode = /^psa-\d+$/i.test(target);
    const { data: sub, error: readErr } = await supabase
      .from('psa_submissions')             // <-- use your table name
      .select('id,status')
      .eq(isCode ? 'code' : 'id', target)
      .single();

    if (readErr || !sub) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'submission_not_found' }));
      return;
    }

    const curr = String(sub.status || '').toLowerCase();
    if ((RANK[to] ?? -1) < (RANK[curr] ?? -1)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'cannot_move_backward' }));
      return;
    }

    // Update submission
    const { error: updErr } = await supabase
      .from('psa_submissions')             // <-- use your table name
      .update({ status: to, updated_at: new Date().toISOString() })
      .eq('id', sub.id);

    if (updErr) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error: updErr.message || 'update_failed' }));
      return;
    }

    // Cascade to all cards in this submission to keep admin + portal aligned
    if (cascade_cards) {
      const { error: cardsErr } = await supabase
        .from('submission_cards')          // <-- use your cards table name
        .update({ status: to })
        .eq('submission_id', sub.id);

      if (cardsErr) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok:false, error:`cards_update_failed: ${cardsErr.message}` }));
        return;
      }
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok:true, submission_id: sub.id, status: to, cascaded: !!cascade_cards }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok:false, error:String(err?.message || 'server_error') }));
  }
}
