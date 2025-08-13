// /api/proxy/submissions.js
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SHOPIFY_API_SECRET, // from your Shopify app's "Client secret"
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Verify Shopify App Proxy HMAC from the querystring
function verifyProxyHmac(query) {
  const { signature, ...rest } = query || {};
  if (!signature || !SHOPIFY_API_SECRET) return false;
  const msg = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(msg).digest('hex');
  return digest === signature;
}

export default async function handler(req, res) {
  // Only allow GET
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // App Proxy responses should not be cached
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // Must be a valid signed proxy request
  if (!verifyProxyHmac(req.query)) {
    return res.status(403).json({ error: 'invalid_signature' });
  }

  // Shopify provides the logged in customer id on proxy requests
  const customerIdRaw =
    req.query.logged_in_customer_id ||
    req.headers['x-shopify-customer-id'] ||
    req.headers['x-shopify-logged-in-customer-id'];

  const customerIdNum = Number(customerIdRaw);
  if (!Number.isFinite(customerIdNum)) {
    return res.status(401).json({ error: 'not_logged_in' });
  }

  try {
    // Query your real table
    const { data, error } = await supabase
      .from('psa_submissions')
      .select(`
        submission_id,
        created_at,
        submitted_at_iso,
        cards,
        status,
        totals,
        number,
        submission_no,
        id,
        ref,
        code,
        shopify_customer_id
      `)
      .eq('shopify_customer_id', customerIdNum)
      .order('submitted_at_iso', { ascending: false });

    if (error) throw error;

    // Your frontend handles either array or {submissions: []}
    return res.status(200).json({ submissions: data || [] });
  } catch (e) {
    console.error('[proxy/submissions] error', e);
    return res.status(500).json({ error: 'server_error' });
  }
}
