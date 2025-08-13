// /api/proxy/submissions.js
export default async function handler(req, res) {
  // App Proxy responses should not be cached by Shopify/CDN
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // Shopify passes the logged-in customer ID in a header for proxies
  const customerId =
    req.headers['x-shopify-logged-in-customer-id'] ||
    req.query.logged_in_customer_id ||
    req.query.customer_id;

  if (!customerId) {
    return res.status(401).json({ ok: false, error: 'not_logged_in' });
  }

  // TODO: Replace with Supabase lookup later.
  // For now return some mock submissions so we can wire up the UI.
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

  res.status(200).json({ ok: true, customerId: String(customerId), submissions });
}
