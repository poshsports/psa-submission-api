// api/submit.js
import { createClient } from '@supabase/supabase-js';

// --- ENV required ---
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE (preferred) or SUPABASE_ANON_KEY (service role is best for upserts)
// Optional: ALLOWED_ORIGINS (comma-separated), e.g. "https://yourstore.com,https://admin.shopify.com"

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[submit] Missing Supabase env vars');
}

const supabase = createClient(supabaseUrl, supabaseKey);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function cors(res, reqOrigin) {
  const origin = allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0] || '*';
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res, req.headers.origin || '');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  // Parse JSON body
  let payload;
  try {
    payload = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid JSON' });
  }

  // Minimal validation
  const submission_id = String(payload.submission_id || '').trim();
  if (!submission_id) {
    return res.status(400).json({ ok: false, error: 'submission_id is required' });
  }

  // Normalize fields (everything else is stored as JSONB)
  const row = {
    submission_id,
    status: payload.status || null,
    submitted_via: payload.submitted_via || null,
    submitted_at_iso: payload.submitted_at_iso || new Date().toISOString(),
    customer_email: payload.customer_email || null,

    // JSONB columns (create these as jsonb in Supabase):
    address: payload.address ?? null,
    totals: payload.totals ?? null,
    card_info: payload.card_info ?? null,
    shopify: payload.shopify ?? null,

    // Anything else you want to keep verbatim:
    raw: payload, // optional: keep entire payload for auditing
  };

  try {
    // Upsert into a table, e.g. "psa_submissions"
    // Schema suggestion:
    // submission_id (text, PK or unique), status (text), submitted_via (text), submitted_at_iso (timestamptz),
    // customer_email (text), address (jsonb), totals (jsonb), card_info (jsonb), shopify (jsonb), raw (jsonb)
    const { data, error } = await supabase
      .from('psa_submissions')
      .upsert(row, { onConflict: 'submission_id' }) // requires a UNIQUE index on submission_id
      .select()
      .single();

    if (error) {
      console.error('[submit] Supabase upsert error:', error);
      return res.status(500).json({ ok: false, error: 'Database error' });
    }

    return res.status(200).json({ ok: true, id: data.submission_id });
  } catch (e) {
    console.error('[submit] Unexpected error:', e);
    return res.status(500).json({ ok: false, error: 'Unexpected error' });
  }
}
