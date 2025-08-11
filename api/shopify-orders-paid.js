// /api/shopify-orders-paid.js
import crypto from 'crypto';

const EVAL_VARIANT_ID = '51003437613332';
const SUPABASE_ENDPOINT =
  process.env.SUPABASE_SUBMIT_URL || 'https://psa-submission-api.vercel.app/api/submit';

// flip to '1' temporarily if you want extra logs
const DEBUG = process.env.DEBUG_PSA_WEBHOOK === '1';
const dlog = (...a) => DEBUG && console.log('[PSA Webhook]', ...a);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  // --- 1) Read RAW body (must be raw for HMAC) ---
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks);

  // --- 2) HMAC verify ---
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[PSA Webhook] Missing SHOPIFY_WEBHOOK_SECRET');
    return res.status(500).send('Missing webhook secret');
  }
  const sentHmac = req.headers['x-shopify-hmac-sha256'];
  if (!sentHmac) return res.status(401).send('Missing HMAC');

  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  try {
    const ok = crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sentHmac));
    if (!ok) return res.status(401).send('HMAC verification failed');
  } catch {
    // timingSafeEqual throws if lengths differ
    return res.status(401).send('HMAC verification failed');
  }

  // --- 3) Parse JSON only after verification ---
  let order;
  try {
    order = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  // --- 4) Does this order include the eval SKU? ---
  const hasEval = Array.isArray(order?.line_items) &&
    order.line_items.some(li => String(li.variant_id) === EVAL_VARIANT_ID);

  if (!hasEval) {
    dlog('Order has no eval line item; skipping.', { order: order?.name, id: order?.id });
    return res.status(200).json({ ok: true, skipped: true });
  }

  // --- 5) Read note attributes and extract our ids/payload ---
  const noteAttrsArr = Array.isArray(order?.note_attributes) ? order.note_attributes : [];
  const attrs = noteAttrsArr.reduce((acc, cur) => {
    const k = (cur?.name || '').toLowerCase();
    acc[k] = String(cur?.value ?? '');
    return acc;
  }, {});

  const submissionId = attrs['psa_submission_id'] || '';
  if (!submissionId) {
    // We can't correlate without the id; log and bail safely.
    console.warn('[PSA Webhook] Missing psa_submission_id on order', { order: order?.name, id: order?.id });
    return res.status(200).json({ ok: true, missing_submission_id: true });
  }

  // Optional: decode small payload if present (not required for update)
  let basePayload = null;
  if (attrs['psa_payload_b64']) {
    try {
      let decoded = Buffer.from(attrs['psa_payload_b64'], 'base64').toString('utf8');
      try { decoded = decodeURIComponent(decoded); } catch {}
      basePayload = JSON.parse(decoded);
    } catch (e) {
      console.warn('[PSA Webhook] Failed to decode psa_payload_b64:', e);
    }
  }

  // --- 6) Build update payload and submit to your API ---
  const finalPayload = {
    ...(basePayload || {}),
    submission_id: submissionId,                 // <<< correlate to existing row
    status: 'submitted_paid',                    // <<< mark as paid
    submitted_via: 'webhook_orders_paid',
    paid_at_iso: new Date().toISOString(),
    shopify: {
      id: order?.id,
      name: order?.name,
      order_number: order?.order_number,
      email: order?.email,
      currency: order?.currency,
      total_price: order?.total_price,
      created_at: order?.created_at,
      note_attributes: noteAttrsArr,
      line_items: order?.line_items || [],
    },
  };

  try {
    const resp = await fetch(SUPABASE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finalPayload),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error('[PSA Webhook] Submit failed', resp.status, txt);
      return res.status(500).send('Submit failed');
    }
  } catch (e) {
    console.error('[PSA Webhook] Submit error', e);
    return res.status(500).send('Submit error');
  }

  console.log('[orders-paid] OK', {
    id: order?.id,
    email: order?.email,
    order: order?.name,
    submissionId,
  });

  return res.status(200).json({ ok: true, updated_submission_id: submissionId });
}
