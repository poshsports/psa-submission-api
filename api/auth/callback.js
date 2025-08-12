// /api/auth/callback.js
export default async function handler(req, res) {
  try {
    const { shop, code, state } = req.query;

    // Simple state check (optional but recommended)
    const cookieState = (req.headers.cookie || '').split('; ').find(c => c.startsWith('shopify_state='))?.split('=')[1];
    if (!state || !cookieState || state !== cookieState) {
      return res.status(400).send('Invalid state');
    }

    if (!shop || !code) {
      return res.status(400).send('Missing shop or code');
    }

    const accessTokenUrl = `https://${shop}/admin/oauth/access_token`;
    const tokenRes = await fetch(accessTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code
      })
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error('Access token exchange failed:', text);
      return res.status(500).send('Access token exchange failed');
    }

    const tokenJson = await tokenRes.json();
    // tokenJson.access_token is your permanent Admin API token for this shop
    // For your proxy-only use-case you may not need to store it, but you can persist it to Supabase if needed.

    // Done! Send them to your success page.
    // (You can also redirect to an embedded admin page if you add one later.)
    return res.redirect('/api/ok');
  } catch (err) {
    console.error('auth/callback error', err);
    res.status(500).send('OAuth callback failed');
  }
}
