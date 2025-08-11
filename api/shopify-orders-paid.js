// /api/shopify-orders-paid.js
import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[PSA Webhook] Missing SHOPIFY_WEBHOOK_SECRET');
    return res.status(500).send('Missing webhook secret');
  }

  // 1) Read RAW body (important for HMAC)
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks);

  // 2) Compute + compare HMAC
  const sentHmac = req.headers['x-shopify-hmac-sha256'];
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

  // DEBUG: log what we're comparing (safe: only show first 5 of secret)
  console.log('[PSA Webhook] HMAC check', {
    secretFirst5: secret.substring(0, 5),
    sentHmac: sentHmac || '(none)',
    computed
  });

  if (!sentHmac) return res.status(401).send('Missing HMAC');

  let ok = false;
  try {
    ok = crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sentHmac));
  } catch (e) {
    console.warn('[PSA Webhook] timingSafeEqual threw', e);
  }
  if (!ok) {
    console.warn('[PSA Webhook] HMAC verification failed');
    return res.status(401).send('HMAC verification failed');
  }

  // 3) Safe to parse JSON now
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  console.log('[orders-paid] OK', {
    id: payload?.id,
    email: payload?.email,
    line_items: payload?.line_items?.length,
  });

  return res.status(200).send('ok');
}
