// /api/submissions.js — Vercel serverless function (no Admin API needed)
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,   // service role key
  SHOPIFY_API_SECRET,     // App Proxy secret
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Verify Shopify App Proxy signature (query param: `signature`)
function verifyProxyHmac(query) {
  const { signature, ...rest } = query || {};
  const msg = Object.keys(rest)
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join('');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(msg).digest('hex');
  return digest === signature;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!verifyProxyHmac(req.query)) {
      return res.status(403).json({ error: 'Invalid signature' });
    }

    // Ensure numeric compare to match your Supabase column type
    const customerIdRaw = req.query.logged_in_customer_id;
    const customerIdNum = Number(customerIdRaw);
    if (!Number.isFinite(customerIdNum)) {
      return res.status(401).json({ error: 'Not logged in' });
    }

    const { data, error } = await supabase
      .from('psa_submissions')
      .select(`
        submission_id,
        created_at,
        submitted_at_iso,
        cards,
        card_count,
        quantity,
        items,
        status,
        totals,
        grading_total,
        amount_cents,
        total,
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

    return res.status(200).json({ submissions: data || [] });
  } catch (e) {
    console.error('submissions endpoint error', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
