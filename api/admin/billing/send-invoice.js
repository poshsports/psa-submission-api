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
    const ok = await requireAdmin(req, res);
if (!ok) return; // 401 already sent by requireAdmin
    if (!STORE || !ADMIN_TOKEN) return json(res, 500, { error: 'Missing Shopify env vars' });

let { invoice_id, to, customer_email, subject, message, subs } = await readBody(req);

// If no invoice_id, auto-create one from subs+email
if (!invoice_id) {
  if (!customer_email || !Array.isArray(subs) || !subs.length) {
    return json(res, 400, { error: 'invoice_id is required or provide { customer_email, subs[] }' });
  }

  const qp = new URLSearchParams({
    subs: subs.join(','),
    email: customer_email
  });

  const pre = await fetch(
    `${getOrigin(req)}/api/admin/billing/preview/prefill?${qp.toString()}`,
    {
      method: 'GET',
      headers: { 'cookie': req.headers.cookie || '' }
    }
  ).then(r => r.ok ? r.json() : null);

  invoice_id = pre?.invoice_id || null;

  if (!invoice_id) {
    return json(res, 400, { error: 'Could not auto-create invoice' });
  }
}

   const client = sb();
// Track whether we created a Shopify draft in this request
let createdDraftHere = false;

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
  const draftResp = await fetch(`${getOrigin(req)}/api/admin/billing/create-drafts`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    // forward session so requireAdmin() passes
    'cookie': req.headers.cookie || ''
  },
  body: JSON.stringify({ invoice_ids: [String(invoice_id)] })
});

if (!draftResp.ok) {
  const errText = await draftResp.text().catch(()=>'');
  return json(res, 400, { error: 'Invoice has no draft_id (create-drafts failed)', details: errText });
}
createdDraftHere = true;

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
    let toEmail = (to || customer_email || '').trim();
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
// Ensure all bundle-eligible submissions are attached before sending
const { data: invRow } = await client
  .from('billing_invoices')
  .select(`
    id,
    ship_to_line1,
    ship_to_line2,
    ship_to_city,
    ship_to_region,
    ship_to_postal,
    ship_to_country
  `)
  .eq('id', invoice_id)
  .single();

if (!invRow) {
  return json(res, 400, { error: 'Invoice missing ship-to address; cannot bundle.' });
}

const shipKey = [
  invRow.ship_to_line1,
  invRow.ship_to_line2,
  invRow.ship_to_city,
  invRow.ship_to_region,
  invRow.ship_to_postal,
  invRow.ship_to_country || 'US'
]
  .map(v => String(v || '').trim().toLowerCase())
  .filter(Boolean)
  .join(', ')
  .replace(/\s+/g, ' ')
  .trim();
// DEBUG: show how we’re resolving the bundle at send-time
console.log('[send-invoice] invoice_id=', invoice_id);
console.log('[send-invoice] toEmail=', toEmail);
console.log('[send-invoice] computed shipKey=', shipKey);

// Fetch all candidate bundles for this customer (to see the address keys the DB expects)
const { data: candidates, error: candErr } = await client
  .from('billing_to_bill_v')
  .select('normalized_address_key, submission_ids')
  .eq('customer_email', toEmail);

if (candErr) {
  console.log('[send-invoice] candidates error=', candErr.message);
} else {
  console.log('[send-invoice] candidate bundles=', candidates);
}

// What *should* be bundled right now
// Resolve what *should* be on this invoice.
// First try strict address match; if that fails, fall back to *all*
// current billable submissions for this customer so nothing is left behind.
let shouldHave = new Set();

const { data: bundle } = await client
  .from('billing_to_bill_v')
  .select('submission_ids')
  .eq('customer_email', toEmail)
  .eq('normalized_address_key', shipKey)
  .maybeSingle();

if (bundle?.submission_ids?.length) {
  shouldHave = new Set(bundle.submission_ids);
} else {
  // Fallback: grab *all* billable bundles for this customer
  const { data: fb } = await client
    .from('billing_to_bill_v')
    .select('submission_ids')
    .eq('customer_email', toEmail);

  const all = (fb || []).flatMap(r => r.submission_ids || []);
  shouldHave = new Set(all);
}

console.log('[send-invoice] resolved shouldHave=', [...shouldHave]);


// What is *already* linked
const { data: existing } = await client
  .from('billing_invoice_submissions')
  .select('submission_code')
  .eq('invoice_id', invoice_id);

const already = new Set((existing || []).map(r => r.submission_code));
console.log('[send-invoice] already linked submission_codes=', [...already]);

// Attach anything missing
const missing = [...shouldHave].filter(x => !already.has(x));
console.log('[send-invoice] missing to attach=', missing);

if (missing.length) {
  await client.from('billing_invoice_submissions').insert(
    missing.map(code => ({ invoice_id, submission_code: code }))
  );
}


    // 3) Send the invoice email via Shopify
const label = inv.group_code || inv.id;
const payload = {
  draft_order_invoice: {
    to: toEmail,
    subject: subject || `PSA Balance — ${label}`,
    custom_message: message || `Your PSA grading balance${inv.group_code ? ` for group ${inv.group_code}` : ''} is ready.`
  }
};
   let result;
try {
  result = await sendWithRetry(inv.draft_id, payload);
} catch (e) {
  // If we created a draft during this request and sending failed,
  // clean up the draft and return the invoice to "pending" so it
  // shows in the "To send" tab again.
  try {
    if (createdDraftHere && inv.draft_id) {
      // best-effort cleanup in Shopify
      try { await shopifyFetch(`/draft_orders/${inv.draft_id}.json`, 'DELETE'); } catch {}
      // clear draft refs in DB
      await client.from('billing_invoices')
        .update({
          status: 'pending',
          draft_id: null,
          invoice_url: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', invoice_id);
    } else {
      // if a draft existed already, just bump status back to pending
      await client.from('billing_invoices')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('id', invoice_id);
    }
  } catch {}
  return json(res, 502, {
    error: 'Shopify could not send the invoice yet. Please try again.',
    details: String(e?.message || e)
  });
}

// Move submissions to balance_due only AFTER a successful send
try {
  const { data: links2 } = await client
    .from('billing_invoice_submissions')
    .select('submission_code')
    .eq('invoice_id', invoice_id);

  const codes = (links2 || []).map(l => l.submission_code).filter(Boolean);
  if (codes.length) {
    await client
      .from('psa_submissions')
      .update({ status: 'balance_due' })
      .in('submission_id', codes);
  }
} catch {}

    // Ensure invoice_url is present on the invoice row (rarely missing)
try {
  const draft = await shopifyFetch(`/draft_orders/${inv.draft_id}.json`, 'GET');
  const url = draft?.draft_order?.invoice_url || null;
  if (url) {
    await client.from('billing_invoices')
      .update({ invoice_url: url, updated_at: new Date().toISOString() })
      .eq('id', invoice_id);
  }
} catch {}

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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Retry wrapper for Shopify "not finished calculating" 422s
async function sendWithRetry(draftId, payload, maxAttempts = 6) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await shopifyFetch(`/draft_orders/${draftId}/send_invoice.json`, 'POST', payload);
    } catch (e) {
      const msg = String(e?.message || e);
      // Shopify uses 422 with this exact phrase
      if (msg.includes('not finished calculating')) {
        // Touch the draft (GET) and back off a bit, then retry
        try { await shopifyFetch(`/draft_orders/${draftId}.json`, 'GET'); } catch {}
        await sleep(500 * attempt);  // backoff: 400ms, 800ms, 1200ms, ...
        continue;
      }
      throw e; // real error -> bubble up
    }
  }
  throw new Error('Draft still calculating after retries');
}

async function readBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(Buffer.from(ch));
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}
