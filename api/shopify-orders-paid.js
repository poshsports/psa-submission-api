// api/shopify-orders-paid.js
import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return res.status(500).send('Missing webhook secret');

  // 1) Read RAW body
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks);

  // 2) Verify HMAC
  const sentHmac = req.headers['x-shopify-hmac-sha256'];
  if (!sentHmac) return res.status(401).send('Missing HMAC');

  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

  const ok = crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sentHmac));
  if (!ok) return res.status(401).send('HMAC verification failed');

  // 3) Now it's safe to parse
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  // --- your logic here ---
  // e.g., check for your eval variant, upsert submission, etc.
  console.log('[orders-paid] OK', {
    id: payload?.id,
    email: payload?.email,
    line_items: payload?.line_items?.length,
  });

  return res.status(200).send('ok');
}
