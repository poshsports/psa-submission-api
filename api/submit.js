// api/submit.js
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

// Optional: restrict to your storefronts via env:
// ALLOWED_ORIGINS="https://poshsports.com,https://www.poshsports.com"
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function cors(res, reqOrigin) {
  const origin =
    allowedOrigins.length === 0
      ? '*'
      : allowedOrigins.includes(reqOrigin)
      ? reqOrigin
      : allowedOrigins[0];

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey)
  : null;

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ensureUuid(v) {
  const s = (v ?? '').toString().trim();
  if (UUID_V4_RE.test(s)) return s.toLowerCase();
  return crypto.randomUUID();
}

// Normalize grading service coming from the form (top-level or per-card)
function pickGradingService(payload = {}) {
  const direct =
    payload.psa_grading ||
    payload.grading_service ||
    payload.service_level ||
    payload.service ||
    null;
  if (direct) return String(direct).trim();

  const items = Array.isArray(payload.card_info) ? payload.card_info : [];
  const vals = [];
  for (const o of items) {
    const v =
      o?.psa_grading ||
      o?.grading_service ||
      o?.service_level ||
      o?.service ||
      o?.tier ||
      o?.level;
    if (v) vals.push(String(v).trim());
  }
  if (!vals.length) return null;

  const uniq = [...new Set(vals)];
  return uniq.length === 1 ? uniq[0] : `Mixed: ${uniq.slice(0,3).join(', ')}${uniq.length>3 ? '…' : ''}`;
}

export default async function handler(req, res) {
  cors(res, req.headers.origin || '');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  if (!supabase) {
    console.error('[submit] Missing SUPABASE_URL or key');
    return res.status(500).json({ ok: false, error: 'Server misconfigured' });
  }

  // Parse JSON safely
  let payload = {};
  try {
    payload = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid JSON' });
  }

  // ---- Inputs / normalization ----
  const email = (payload.customer_email || '').trim().toLowerCase();
  const cardsNumRaw = Number(payload.cards);
  const cards = Number.isFinite(cardsNumRaw)
    ? Math.max(0, Math.trunc(cardsNumRaw))
    : (Array.isArray(payload.card_info) ? payload.card_info.length : 1);

  const totals = payload.totals || {};
  const evalAmtRaw =
    typeof payload.evaluation === 'number'
      ? payload.evaluation
      : totals?.evaluation;
  const evaluation = Number.isFinite(Number(evalAmtRaw))
    ? Math.max(0, Math.trunc(Number(evalAmtRaw)))
    : 0;

  if (!email || !cards) {
    return res.status(400).json({ ok: false, error: 'bad_request', detail: 'Missing email or cards' });
  }

  // ---- IMPORTANT: compute status on the server (ignore client status) ----
  const isEval = evaluation > 0;
  const status = isEval ? 'pending_payment' : 'submitted';
  const submitted_via = isEval ? 'form_precheckout' : 'form_no_payment';

  // ---- Build row (do NOT set submission_id; DB will assign psa-###) ----
  const row = {
    cards,
    evaluation,
    status,
    submitted_via,
    submitted_at_iso: payload.submitted_at_iso ?? new Date().toISOString(),
    customer_email: email,
    address: payload.address ?? null,      // jsonb
    totals,                                // jsonb
    card_info: payload.card_info ?? null,  // jsonb
    shopify_customer_id: payload.shopify_customer_id ?? null,
    shopify: payload.shopify ?? null,      // jsonb
    raw: payload ?? null,                  // jsonb audit copy
    grading_service: pickGradingService(payload),
  };

    try {
    // Insert and try to get back the id.
    // If the trigger swallows/merges the row, PostgREST can return 0 rows (PGRST116).
    let id = null;

    const ins = await supabase
      .from('psa_submissions')
      .insert(row)
      .select('submission_id, created_at')
      .maybeSingle(); // <-- allows 0 or 1 rows

    if (ins.error && ins.error.code !== 'PGRST116') {
      console.error('[submit] insert error:', ins.error);
      return res.status(500).json({
        ok: false,
        error: 'insert_failed',
        code: ins.error.code,
        message: ins.error.message,
        details: ins.error.details,
        hint: ins.error.hint,
      });
    }

    if (ins.data?.submission_id) {
      id = ins.data.submission_id;
    } else {
      // Fallback: if the trigger deduped/upgraded an existing row, fetch the most recent match.
      const since = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // last 5 minutes

      let sel = supabase
        .from('psa_submissions')
        .select('submission_id, created_at')
        .eq('customer_email', email)
        .eq('cards', cards)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      // include grading_service in the match; handle NULL vs non-NULL correctly
      if (row.grading_service == null) {
        sel = sel.is('grading_service', null);
      } else {
        sel = sel.eq('grading_service', row.grading_service);
      }

      const { data: found, error: selErr } = await sel;
      if (!selErr && found) id = found.submission_id;
    }

    return res.status(200).json({ ok: true, id });
  } catch (e) {
    console.error('[submit] Unexpected error:', e);
    return res.status(500).json({
      ok: false,
      error: 'Unexpected error',
      message: e?.message || String(e),
    });
  }

}
