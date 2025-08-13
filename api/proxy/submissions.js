// /api/proxy/submissions.js
const crypto = require('crypto');
const { getSubmissionsByCustomer } = require('../../lib/getSubmissionsByCustomer');

const { SHOPIFY_API_SECRET } = process.env;

// Verify Shopify App Proxy signature (query param: `signature`)
function verifyProxyHmac(query) {
  const { signature, ...rest } = query || {};
  // Shopify expects keys sorted and concatenated key=value with no separators
  const msg = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(msg).digest('hex');
  return digest === signature;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    // App Proxy responses should not be cached by Shopify/CDN
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');

    // Validate App Proxy signature
    if (!verifyProxyHmac(req.query)) {
      return res.status(403).json({ ok: false, error: 'invalid_signature' });
    }

    // Shopify injects this in App Proxy requests
    const customerIdRaw =
      req.query.logged_in_customer_id ||
      req.headers['x-shopify-customer-id'] ||
      req.headers['x-shopify-logged-in-customer-id'];

    const customerIdNum = Number(customerIdRaw);
    if (!Number.isFinite(customerIdNum)) {
      return res.status(401).json({ ok: false, error: 'not_logged_in' });
    }

    const submissions = await getSubmissionsByCustomer(customerIdNum);

    return res.status(200).json({
      ok: true,
      customerId: String(customerIdNum),
      submissions,
    });
  } catch (e) {
    console.error('proxy/submissions error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
};
