// api/submit.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

// Optional: restrict to your storefronts via env ALLOWED_ORIGINS="https://poshsports.com,https://www.poshsports.com"
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

export default async function handler(req, res) {
  cors(res, req.headers.origin || '');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

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

  const submission_id = String(payload.submission_id || '').trim();
  if (!submission_id) {
    return res.status(400).json({ ok: false, error: 'submission_id is required' });
  }

  if (!supabase) {
    console.error('[submit] Missing SUPABASE_URL or key');
    return res.status(500).json({ ok: false, error: 'Server misconfigured' });
  }

  const row = {
    submission_id,
    status: payload.status || null,
    submitted_via: payload.submitted_via || null,
    submitted_at_iso: payload.submitted_at_iso || new Date().toISOString(),
    customer_email: payload.customer_email || null,
    address: payload.address ?? null,
    totals: payload.totals ?? null,
    card_info: payload.card_info ?? null,
    shopify: payload.shopify ?? null,
    raw: payload, // audit copy
  };

  try {
const { error } = await supabase
  .from('psa_submissions')
  .upsert(row, { onConflict: 'submission_id' });

if (error) {
  console.error('[submit] Supabase upsert error:', error);
  return res.status(500).json({ ok: false, error: 'Database error' });
}
return res.status(200).json({ ok: true, id: submission_id });
  } catch (e) {
    console.error('[submit] Unexpected error:', e);
    return res.status(500).json({ ok: false, error: 'Unexpected error' });
  }
}
