// /api/submissions.js  -- Vercel serverless function
// Returns the logged-in customer's PSA submissions for the portal UI.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// --- ENV names aligned to your Vercel variables (from your screenshot) ---
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,           // your service-role key (server-only)
  SHOPIFY_API_SECRET,             // App Proxy secret (NOT the Admin token)
  SHOPIFY_ADMIN_API_ACCESS_TOKEN, // Admin API access token
  SHOPIFY_STORE,                  // e.g. "poshsports.myshopify.com"  <-- add this
  SHOPIFY_API_VERSION,            // optional; falls back if missing
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- Verify Shopify App Proxy signature (param: `signature`) ---
function verifyProxyHmac(query) {
  const { signature, ...rest } = query || {};
  const sorted = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('');
  const digest = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(sorted)
    .digest('hex');
  return digest === signature;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // 1) Verify App Proxy signature
    if (!verifyProxyHmac(req.query)) {
      return res.status(403).json({ error: 'Invalid signature' });
    }

    // 2) Must be logged in (Shopify injects logged_in_customer_id on proxy)
    const customerId = String(req.query.logged_in_customer_id || '');
    if (!customerId) return res.status(401).json({ error: 'Not logged in' });

    // 3) Lookup customer email via Admin API (ID -> email)
    const apiVersion = SHOPIFY_API_VERSION || '2024-10';
    const adminResp = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/${apiVersion}/customers/${customerId}.json`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      }
    );

    if (!adminResp.ok) {
      const text = await adminResp.text().catch(() => '');
      return res
        .status(500)
        .json({ error: 'Failed to fetch customer', debug: text });
    }

    const { customer } = await adminResp.json();
    const email = (customer?.email || '').trim().toLowerCase();
    if (!email) return res.status(404).json({ error: 'Customer email not found' });

    // 4) Fetch submissions for this email from Supabase
    const { data, error } = await supabase
      .from('submissions')
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
        code
      `)
      .eq('customer_email', email)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // 5) Return payload (your frontend normalizes keys)
    return res.status(200).json({ submissions: data || [] });
  } catch (e) {
    console.error('submissions endpoint error', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
