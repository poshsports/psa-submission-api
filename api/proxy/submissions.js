// /api/proxy/submissions.js
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const { SHOPIFY_API_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Verify Shopify App Proxy signature (query contains `signature`)
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

    // 1) signature check
    if (!verifyProxyHmac(req.query)) {
      return res.status(403).json({ ok: false, error: 'invalid_signature' });
    }

    // 2) customer id provided by Shopify
    const customerIdRaw =
      req.query.logged_in_customer_id ||
      req.headers['x-shopify-customer-id'] ||
      req.headers['x-shopify-logged-in-customer-id'];

    const customerIdNum = Number(customerIdRaw);
    if (!Number.isFinite(customerIdNum)) {
      return res.status(401).json({ ok: false, error: 'not_logged_in' });
    }

    // 3) fetch minimal shape we need
    const { data, error } = await supabase
      .from('psa_submissions')
      .select(`
        submission_id,
        created_at,
        submitted_at_iso,
        cards,
        status,
        totals,
        grading_total,
        shopify_customer_id
      `)
      .eq('shopify_customer_id', customerIdNum)
      .order('submitted_at_iso', { ascending: false });

    if (error) {
      console.error('Supabase query error:', error);
      return res.status(500).json({ ok: false, error: 'db_error' });
    }

    return res.status(200).json({
      ok: true,
      customerId: String(customerIdNum),
      submissions: data || [],
    });
  } catch (e) {
    console.error('proxy/submissions error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}
