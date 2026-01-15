// /api/proxy/submissions.js  (ESM)
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const {
  SHOPIFY_API_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function verifyProxyHmac(query = {}) {
  const { signature, ...rest } = query;
  const msg = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(msg).digest('hex');
  return digest === signature;
}

export default async function handler(req, res) {
  // --- CORS allowlist ---
  const allowedOrigins = [
    'https://poshsports.com',
    'https://www.poshsports.com',
    'https://poshsports.myshopify.com'
  ];

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight OPTIONS
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');

    if (req.query.ping) {
      return res.status(200).json({
        ok: true,
        where: '/api/proxy/submissions',
        query: req.query,
      });
    }

    const devBypass =
      process.env.NODE_ENV !== 'production' && req.query.dev_skip_sig === '1';
    if (!devBypass && !verifyProxyHmac(req.query)) {
      return res.status(403).json({ ok: false, error: 'invalid_signature' });
    }

    const customerIdRaw =
      req.query.logged_in_customer_id ||
      req.headers['x-shopify-customer-id'] ||
      req.headers['x-shopify-logged-in-customer-id'];

    const customerIdNum = Number(customerIdRaw);
    if (!Number.isFinite(customerIdNum)) {
      return res.status(401).json({ ok: false, error: 'not_logged_in' });
    }

// Select columns we use. Keep only columns we KNOW exist.
const { data, error } = await supabase
  .from('psa_submissions')
  .select(`
    id,
    submission_id,
    created_at,
    submitted_at_iso,
    cards,
    grading_service,
    status,
    totals,
    shopify_customer_id
  `)
  .eq('shopify_customer_id', customerIdNum)
  .order('submitted_at_iso', { ascending: false });

if (error) {
  console.error('Supabase query error:', error);
  return res.status(500).json({ ok: false, error: 'db_error' });
}
// --- Upcharge rollup (so portal totals include upcharges even without card_info) ---
const submissionUuids = (data || []).map(r => r.id).filter(Boolean);

let upchargeBySubmissionId = new Map();

if (submissionUuids.length) {
  const { data: cardRows, error: cardErr } = await supabase
    .from('psa_cards')
    .select('submission_id, upcharge_cents')
    .in('submission_id', submissionUuids);

  if (cardErr) {
    console.error('Supabase psa_cards query error:', cardErr);
  } else {
    for (const row of (cardRows || [])) {
      const sid = row.submission_id;
      const cents = Number(row.upcharge_cents) || 0;
      upchargeBySubmissionId.set(sid, (upchargeBySubmissionId.get(sid) || 0) + cents);
    }
  }
}

// Normalize to what the front-end expects
const submissions = (data || []).map((r) => {
  // Keep the stable DB uuid for internal identity
  const rawId = r.id;

  // Prefer a truly friendly submission_id if present (and not just a uuid)
  const isUuid = (v) => /^[0-9a-f-]{36}$/i.test(String(v || ""));
  let display_id = r.submission_id && !isUuid(r.submission_id)
    ? r.submission_id
    : null;

  // If no friendly submission_id, synthesize one like SUB-YYYYMMDD-ABCDE
  if (!display_id) {
    const dt = new Date(r.submitted_at_iso || r.created_at || Date.now());
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    const datePart = `${y}${m}${d}`; // matches the table's displayed date
    const tail = String(r.submission_id || rawId)
      .replace(/[^a-z0-9]/gi, "")
      .slice(-5)
      .toUpperCase();
    display_id = datePart ? `SUB-${datePart}-${tail}` : `SUB-${tail}`;
  }

const baseTotals = (r.totals && typeof r.totals === 'object') ? { ...r.totals } : {};

const gradingCents =
  Number(baseTotals.grading_cents) ||
  (Number(baseTotals.per_card_cents) || 0) * Number(r.cards ?? 0) ||
  0;

const evalCents = Number(baseTotals.evaluation_cents) || 0;

// Pull the aggregated upcharge cents for this submission UUID
const upchargeCents = upchargeBySubmissionId.get(rawId) || 0;

// Set/override grand_cents so the portal table always matches the modal subtotal logic
baseTotals.grand_cents = gradingCents + evalCents + upchargeCents;

// (Optional but useful to have explicitly)
baseTotals.upcharge_cents = upchargeCents;

return {
  id: rawId, // unchanged for compatibility
  submission_id: r.submission_id || null,
  display_id, // what the UI shows as "Submission #"
  created_at: r.submitted_at_iso || r.created_at,
  cards: r.cards ?? 0,
  grading_total: (r.totals && r.totals.grading) ?? null,
  status: r.status || "received",
  totals: baseTotals,
  grading_service: r.grading_service || null
};
});

return res.status(200).json({
  ok: true,
  customerId: String(customerIdNum),
  submissions,
});

  } catch (e) {
    console.error('proxy/submissions error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}
