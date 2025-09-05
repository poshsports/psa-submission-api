// api/admin/submissions.set-status.js
// Update ONE submission's status. Only allows forward moves.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Allowed statuses (must match util.js + DB CHECK)
const ALLOWED = new Set([
  'pending_payment','submitted','submitted_paid','received',
  'shipped_to_psa','in_grading','graded','shipped_back_to_us',
  'received_from_psa','balance_due','paid','shipped_to_customer','delivered',
]);

// A simple forward-only rank so we don't regress statuses
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
      res.statusCode = 405; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'method_not_allowed' })); return;
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'server_misconfigured' })); return;
    }

    const body = await readJson(req);
    const submissionId = String(body?.submission_id || body?.id || '').trim();
    const status = String(body?.status || '').trim().toLowerCase();

    if (!submissionId) {
      res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'missing_submission_id' })); return;
    }
    if (!ALLOWED.has(status)) {
      res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'invalid_status' })); return;
    }

    // Read current status to prevent regressions
    const { data: sub, error: rErr } = await supabase
      .from('psa_submissions')
      .select('id, group_id, status')
      .eq('id', submissionId)
      .single();

    if (rErr || !sub) {
      res.statusCode = 404; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'submission_not_found' })); return;
    }

    const curr = String(sub.status || '').toLowerCase();
    if (RANK[status] < (RANK[curr] ?? -1)) {
      res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:'cannot_move_backward' })); return;
    }

    // Update
    const { data: upd, error: uErr } = await supabase
      .from('psa_submissions')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', submissionId)
      .select('id, group_id, status')
      .single();

    if (uErr || !upd) {
      res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok:false, error:uErr?.message || 'update_failed' })); return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok:true, submission: upd }));
  } catch (err) {
    res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok:false, error:String(err?.message || err || 'unknown_error') }));
  }
}
