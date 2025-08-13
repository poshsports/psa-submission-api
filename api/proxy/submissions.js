// /api/proxy/submissions.js
export default async function handler(req, res) {
  // Only allow GET
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // App Proxy responses should not be cached by Shopify/CDN
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // Shopify adds `logged_in_customer_id` to the querystring for app proxies
  const customerId =
    req.query.logged_in_customer_id ||
    req.headers['x-shopify-customer-id'] || // optional fallback
    req.headers['x-shopify-logged-in-customer-id']; // optional fallback

  if (!customerId) {
    return res.status(401).json({ ok: false, error: 'not_logged_in' });
  }

  // TODO: replace with real DB (Supabase) lookup
  const submissions = [
    {
      id: 'SUB-10023',
      created_at: '2025-08-08',
      cards: 2,
      grading_total: 40.0,
      status: 'received',
    },
    {
      id: 'SUB-10011',
      created_at: '2025-08-01',
      cards: 3,
      grading_total: 60.0,
      status: 'in_grading',
    },
  ];

  return res.status(200).json({
    ok: true,
    customerId: String(customerId),
    submissions,
  });
}
