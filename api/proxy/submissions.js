// /api/proxy/submissions.js  (ESM)
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const {
  SHOPIFY_API_SECRET,   // App Proxy secret from your custom app
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY, // service role key
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Verify Shopify App Proxy signature: query contains `signature`
function verifyProxyHmac(query = {}) {
  const { signature, ...rest } = query;
  const msg = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(msg).digest('hex');
  return digest === signature;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    // App Proxy responses should not be cached
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');

    // --- Health / signature debug ---
    if (req.query.ping) {
      return res.status(200).json({
        ok: true,
        where: '/api/proxy/submissions',
        query: req.query,
      });
    }

    // TEMP bypass to help debug locally in preview (do NOT leave enabled in prod)
    const devBypass =
      process.env.NODE_ENV !== 'production' && req.query.dev_skip_sig === '1';

    if (!devBypass && !verifyProxyHmac(req.query)) {
      return res.status(403).json({ ok: false, error: 'invalid_signature' });
    }

    // Shopify injects this when the customer is logged in
    const customerIdRaw =
      req.query.logged_in_customer_id ||
      req.headers['x-shopify-customer-id'] ||
      req.headers['x-shopify-logged-in-customer-id'];

    const customerIdNum = Number(customerIdRaw);
    if (!Number.isFinite(customerIdNum)) {
      return res.status(401).json({ ok: false, error: 'not_logged_in' });
    }

    // Select columns we use. Added common human-friendly ids:
    // submission_no / number / code
    const { data, error } = await supabase
      .from('psa_submissions')
      .select(`
        id,
        submission_id,
        submission_no,
        number,
        code,
        created_at,
        submitted_at_iso,
        cards,
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

    // Normalize to what the front-end expects
    const submissions = (data || []).map(r => ({
      // prefer friendly fields; fall back to UUID
      id: r.submission_id || r.submission_no || r.number || r.code || r.id,
      created_at: r.submitted_at_iso || r.created_at,
      cards: r.cards ?? 0,
      // your UI shows “GRADING TOTAL”; pull it from totals JSON
      grading_total: r?.totals?.grading ?? null,
      status: r.status || 'received',
      // include raw totals for future use
      totals: r.totals || null,
    }));

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
