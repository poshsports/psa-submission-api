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

export default async function handler(req, res) {
  cors(res, req.headers.origin || '');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  // Parse JSON safely
  let payload;
  try {
    payload = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid JSON' });
  }

  // Always use a valid UUID for the DB
  const submission_id = ensureUuid(payload.submission_id);

  // STEP 1: parse/normalize `cards` with a safe default
  const cardsNumRaw = Number(payload.cards);
  const parsedCards = Number.isFinite(cardsNumRaw)
    ? Math.max(0, Math.trunc(cardsNumRaw))
    : 1; // choose your default (1 here)
  console.log('[submit] cards payload=', payload.cards, 'parsed=', parsedCards);

  if (!supabase) {
    console.error('[submit] Missing SUPABASE_URL or key');
    return res.status(500).json({ ok: false, error: 'Server misconfigured' });
  }

  // STEP 2: include parsedCards in the row
  const row = {
    submission_id,
    cards: parsedCards,                     // <-- important
    status: payload.status ?? null,
    submitted_via: payload.submitted_via ?? null,
    submitted_at_iso: payload.submitted_at_iso ?? new Date().toISOString(),
    customer_email: payload.customer_email ?? null,
    address: payload.address ?? null,       // jsonb
    totals: payload.totals ?? null,         // jsonb
    card_info: payload.card_info ?? null,   // jsonb
    shopify: payload.shopify ?? null,       // jsonb
    raw: payload ?? null,                   // jsonb audit copy
  };

  try {
    const { error } = await supabase
      .from('psa_submissions')
      .upsert(row, { onConflict: 'submission_id' });

    if (error) {
      console.error('[submit] Supabase upsert error:', error);
      return res.status(500).json({
        ok: false,
        error: 'Database error',
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
    }

    return res.status(200).json({ ok: true, id: submission_id });
  } catch (e) {
    console.error('[submit] Unexpected error:', e);
    return res.status(500).json({
      ok: false,
      error: 'Unexpected error',
      message: e?.message || String(e),
    });
  }
}
