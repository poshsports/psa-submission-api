// /api/auth/start.js
export default async function handler(req, res) {
  try {
    const { SHOPIFY_ADMIN_API_ACCESS_TOKEN, SHOPIFY_API_SECRET, SHOPIFY_API_VERSION, SHOPIFY_API_KEY } = process.env;
    const { shop } = req.query;

    // Require ?shop=your-store.myshopify.com
    if (!shop || !shop.endsWith('.myshopify.com')) {
      return res.status(400).send('Missing or invalid ?shop parameter');
    }

    // Where Shopify will send users back to after they approve
    const baseUrl = `https://${req.headers.host}`;
    const redirectUri = `${baseUrl}/api/auth/callback`;

    // Scopes (you currently don’t need Admin API; leave empty or add as needed, e.g. 'read_customers')
    const scopes = process.env.SHOPIFY_SCOPES || '';

    // Optional: state for CSRF protection (simple and good enough here)
    const state = Math.random().toString(36).slice(2);
    res.setHeader('Set-Cookie', `shopify_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax`);

    const authorizeUrl = `https://${shop}/admin/oauth/authorize` +
      `?client_id=${encodeURIComponent(process.env.SHOPIFY_API_KEY)}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;

    return res.redirect(authorizeUrl);
  } catch (err) {
    console.error('auth/start error', err);
    res.status(500).send('OAuth start failed');
  }
}
