// /api/admin/billing/send-invoice.js  (ESM)
// Sends the Shopify Draft Order invoice for a billing invoice, and marks it as `sent`.

import { sb } from '../../_util/supabase.js';
import { requireAdmin } from '../../_util/adminAuth.js';

const STORE = process.env.SHOPIFY_STORE; // e.g. posh-sports-1194.myshopify.com
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-04';

// Build absolute origin for server-to-server calls (works on Vercel/Netlify)
function getOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  return `${proto}://${host}`;
}

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function shopifyFetch(path, method = 'GET', body) {
  const url = `https://${STORE}/admin/api/${API_VERSION}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      'X-Shopify-Access-Token': ADMIN_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await resp.text().catch(() => '');
  if (!resp.ok) {
    throw new Error(`Shopify ${method} ${path} failed ${resp.status}: ${text || '(no body)'}`);
  }
  return text ? JSON.parse(text) : {};
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    if (!requireAdmin(req)) return json(res, 401, { error: 'Unauthorized' });
    if (!STORE || !ADMIN_TOKEN) return json(res, 500, { error: 'Missing Shopify env vars' });

    const { invoice_id, to, subject, message } = await readBody(req);
    if (!invoice_id) return json(res, 400, { error: 'invoice_id is required' });

    const client = sb();

    // 1) Load the invoice row
    const { data: inv, error: invErr } = await client
      .from('billing_invoices')
      .select('id, group_code, draft_id, status')
      .eq('id', invoice_id)
      .single();
    if (invErr || !inv) return json(res, 404, { error: 'Invoice not found' });
    // If there's no Shopify draft yet, try to create it now via our own API
if (!inv.draft_id) {
  try {
    await fetch(`${getOrigin(req)}/api/admin/billing/create-drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // If your create-drafts expects invoice_ids, use this:
      body: JSON.stringify({ invoice_ids: [String(invoice_id)] }),

      // If your create-drafts expects a different shape (e.g. emails),
      // change the body accordingly after checking that file.
    });

    // Re-load the invoice so we see the draft_id persisted by create-drafts
    const client2 = sb();
    const { data: inv2 } = await client2
      .from('billing_invoices')
      .select('id, group_code, draft_id, status')
      .eq('id', invoice_id)
      .single();

    if (inv2?.draft_id) {
      inv.draft_id = inv2.draft_id;
    } else {
      return json(res, 400, { error: 'Invoice has no draft_id (post-create attempt)' });
    }
  } catch (e) {
    return json(res, 400, { error: 'Invoice has no draft_id (create-drafts failed)' });
  }
}
    // 2) Find a customer email from linked submissions (same customer across all)
    let toEmail = (to || '').trim();
    if (!toEmail) {
      const { data: link, error: linkErr } = await client
        .from('billing_invoice_submissions')
        .select('submission_code')
        .eq('invoice_id', invoice_id)
        .limit(1);
      if (linkErr) return json(res, 500, { error: 'Failed loading invoice links', details: linkErr.message });

      const code = link && link.length ? link[0].submission_code : null;
      if (code) {
        const { data: sub, error: subErr } = await client
          .from('psa_submissions')
          .select('customer_email')
          .eq('submission_id', code)
          .single();
        if (subErr) return json(res, 500, { error: 'Failed loading submission', details: subErr.message });
        toEmail = (sub?.customer_email || '').trim();
      }
    }

    if (!toEmail) {
      return json(res, 400, { error: 'No destination email found. Pass { to: "email@domain" } or ensure submission has customer_email.' });
    }

    // 3) Send the invoice email via Shopify
    const payload = {
      draft_order_invoice: {
        to: toEmail,
        subject: subject || `PSA Balance — ${inv.group_code}`,
        custom_message: message || `Your PSA grading balance for group ${inv.group_code} is ready.`
      }
    };
    const result = await shopifyFetch(`/draft_orders/${inv.draft_id}/send_invoice.json`, 'POST', payload);

    // 4) Mark invoice as sent
    await client
      .from('billing_invoices')
      .update({ status: 'sent', updated_at: new Date().toISOString() })
      .eq('id', invoice_id);

    return json(res, 200, { ok: true, invoice_id, sent_to: toEmail, shopify: result });
  } catch (err) {
    console.error('send-invoice error', err);
    return json(res, 500, { error: String(err?.message || err) });
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(Buffer.from(ch));
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}
