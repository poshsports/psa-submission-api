// Vercel serverless function: /api/submissions.js
// Returns the logged-in customer's PSA submissions for the portal UI.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ---- ENV (set these in your Vercel project) ----
// SUPABASE_URL=...
// SUPABASE_SERVICE_ROLE=...       // server-only key
// SHOPIFY_API_SECRET=...          // App Proxy "Secret" from your Shopify app
// SHOPIFY_ADMIN_TOKEN=...         // Admin API token (private/custom app)
// SHOPIFY_STORE=poshsports.myshopify.com  // your store domain

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
  SHOPIFY_API_SECRET,
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_STORE,
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// --- Verify Shopify App Proxy signature (param: `signature`) ---
function verifyProxyHmac(query) {
  // Build sorted key=value string EXCLUDING `signature`
  const { signature, ...rest } = query || {};
  const sorted = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET)
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
    const adminResp = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-10/customers/${customerId}.json`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      }
    );
    if (!adminResp.ok) {
      const text = await adminResp.text().catch(() => '');
      return res.status(500).json({ error: 'Failed to fetch customer', debug: text });
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

    // 5) Return as the portal expects (array or { submissions: [...] } both OK)
    return res.status(200).json({ submissions: data || [] });
  } catch (e) {
    console.error('submissions endpoint error', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
