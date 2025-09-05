// api/admin/submissions.set-status.js
// Update ONE submission's status (forward-only) and cascade to its cards.
// Accepts submission id *or* code.

import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '../_util/adminAuth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SERVICE_ROLE_KEY; // fallback if you happened to set this

const ALLOWED = new Set([
  'pending_payment','submitted','submitted_paid','received',
  'shipped_to_psa','in_grading','graded','shipped_back_to_us',
  'received_from_psa','balance_due','paid','shipped_to_customer','delivered',
]);

const RANK = {
  pending_payment:0, submitted:1, submitted_paid:2, received:3,
  shipped_to_psa:4, in_grading:5, graded:6, shipped_back_to_us:7,
  received_from_psa:8, balance_due:9, paid:10, shipped_to_customer:11, delivered:12,
};

async function readJson(req){
  if (req.body) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
    if (typeof req.body === 'object') return req.body;
  }
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

export default async function handler(req, res){
  try {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'method_not_allowed' }));
      return;
    }

    const authed = await requireAdmin(req, res);
    if (!authed) return;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'server_misconfigured' }));
      return;
    }

    const body = await readJson(req);
    const key = String(body?.submission_id || body?.id || '').trim(); // can be id OR code
    const status = String(body?.status || '').trim().toLowerCase();

    if (!key) {
      res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'missing_submission_id' })); return;
    }
    if (!ALLOWED.has(status)) {
      res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'invalid_status' })); return;
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    // Look up by id first; if not found, look up by code.
    let sub = null, sErr = null;
    let q = await supabase.from('psa_submissions')
      .select('id, status')
      .eq('id', key)
      .single();
    sub = q.data; sErr = q.error;

    if (!sub) {
      q = await supabase.from('psa_submissions')
        .select('id, status')
        .eq('code', key)
        .single();
      sub = q.data; sErr = q.error;
    }

    if (sErr || !sub) {
      res.statusCode = 404; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'submission_not_found' })); return;
    }

    const resolvedId = sub.id;
    const curr = String(sub.status || '').toLowerCase();
    if (RANK[status] < (RANK[curr] ?? -1)) {
      res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'cannot_move_backward' })); return;
    }

    // 1) Update submission
    const { data: upd, error: uErr } = await supabase
      .from('psa_submissions')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', resolvedId)
      .select('id, status')
      .single();

    if (uErr || !upd) {
      res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:uErr?.message || 'update_failed' })); return;
    }

    // 2) Cascade to cards in that submission
    const { error: cErr, count } = await supabase
      .from('submission_cards')
      .update({ status })
      .eq('submission_id', resolvedId)
      .select('id', { count: 'exact', head: true });

    if (cErr) {
      res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:cErr.message || 'card_update_failed' })); return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok:true, submission_id: upd.id, status: upd.status, cards_updated: count ?? 0 }));
  } catch (err) {
    res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok:false, error:String(err?.message || err || 'unknown_error') }));
  }
}
