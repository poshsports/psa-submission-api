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
    const trace = `send-invoice:${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  const log = (...args) => console.log(`[${trace}]`, ...args);
  const fail = (status, phase, err) => {
    const msg = err?.message || String(err || '');
    console.error(`[${trace}] FAIL @ ${phase}`, err);
    return json(res, status, { error: phase, message: msg, trace });
  };

  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    const ok = await requireAdmin(req, res);
    if (!ok) return; // 401 already sent by requireAdmin
    if (!STORE || !ADMIN_TOKEN) return json(res, 500, { error: 'Missing Shopify env vars' });

    const client = sb();

    let { invoice_id, to, customer_email, subject, message, subs, groups } = await readBody(req);

// If no invoice_id, create one here (Option A: send-invoice owns creation)
if (!invoice_id) {
  if (!customer_email || !Array.isArray(subs) || !subs.length) {
    return json(res, 400, {
      error: 'invoice_id is required or provide { customer_email, subs[] }'
    });
  }

// Determine group_code when auto-creating (billing_invoices.group_code is NOT NULL)
let groupCode = null;

// Prefer explicit groups[] if provided
if (Array.isArray(groups) && groups.length) {
  groupCode = String(groups[0]);
}

// Otherwise derive from first submission via admin_submissions_v
if (!groupCode && Array.isArray(subs) && subs.length) {
  const { data: row, error } = await client
    .from('admin_submissions_v')
    .select('group_code')
    .eq('submission_id', String(subs[0]))
    .single();

  if (error) {
    return fail(500, 'derive_group', error);
  }

  groupCode = row?.group_code || null;
}

if (!groupCode) {
  return fail(400, 'create_invoice', 'Unable to determine group_code for invoice creation');
}


const { data: inv, error: invErr } = await client
  .from('billing_invoices')
  .insert({
    customer_email,
    group_code: groupCode,
    status: 'pending'
  })
  .select('id')
  .single();

if (invErr || !inv) {
  return fail(500, 'create_invoice', invErr || 'insert returned no row');
}

invoice_id = inv.id;
}
    // Resolve destination email early
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

    // Ensure all intended submissions are attached before sending
    let shouldHave = new Set();

    if (Array.isArray(subs) && subs.length) {
      shouldHave = new Set(subs);
    } else {
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

      const { data: bundle } = await client
        .from('billing_to_bill_v')
        .select('submission_ids')
        .eq('customer_email', toEmail)
        .eq('normalized_address_key', shipKey)
        .maybeSingle();

      if (bundle?.submission_ids?.length) {
        shouldHave = new Set(bundle.submission_ids);
      } else {
        const { data: fb } = await client
          .from('billing_to_bill_v')
          .select('submission_ids')
          .eq('customer_email', toEmail);

        const all = (fb || []).flatMap(r => r.submission_ids || []);
        shouldHave = new Set(all);
      }
    }

    const { data: existing } = await client
      .from('billing_invoice_submissions')
      .select('submission_code')
      .eq('invoice_id', invoice_id);

    const already = new Set((existing || []).map(r => r.submission_code));
    const missing = [...shouldHave].filter(x => !already.has(x));

    if (missing.length) {
      await client.from('billing_invoice_submissions').insert(
        missing.map(code => ({ invoice_id, submission_code: code }))
      );
    }

    // Track whether we created a Shopify draft in this request
    let createdDraftHere = false;

    const { data: inv, error: invErr2 } = await client
      .from('billing_invoices')
      .select('id, group_code, draft_id, status')
      .eq('id', invoice_id)
      .single();

    if (invErr2 || !inv) return json(res, 404, { error: 'Invoice not found' });

    if (!inv.draft_id) {
      const draftResp = await fetch(`${getOrigin(req)}/api/admin/billing/create-drafts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cookie': req.headers.cookie || ''
        },
        body: JSON.stringify({ invoice_ids: [String(invoice_id)] })
      });

if (!draftResp.ok) {
  const errText = await draftResp.text().catch(()=> '');
  return fail(400, 'create_draft', errText);
}


      createdDraftHere = true;

      const { data: inv2 } = await client
        .from('billing_invoices')
        .select('id, group_code, draft_id, status')
        .eq('id', invoice_id)
        .single();

      if (inv2?.draft_id) {
        inv.draft_id = inv2.draft_id;
      } else {
        return json(res, 400, { error: 'Invoice has no draft_id (post-create attempt)' });
      }
    }

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
      if (createdDraftHere && inv.draft_id) {
        try { await shopifyFetch(`/draft_orders/${inv.draft_id}.json`, 'DELETE'); } catch {}
        await client.from('billing_invoices')
          .update({
            status: 'pending',
            draft_id: null,
            invoice_url: null,
            updated_at: new Date().toISOString()
          })
          .eq('id', invoice_id);
      } else {
        await client.from('billing_invoices')
          .update({ status: 'pending', updated_at: new Date().toISOString() })
          .eq('id', invoice_id);
      }

return fail(502, 'send_invoice', e);

    }

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

    try {
      const draft = await shopifyFetch(`/draft_orders/${inv.draft_id}.json`, 'GET');
      const url = draft?.draft_order?.invoice_url || null;
      if (url) {
        await client.from('billing_invoices')
          .update({ invoice_url: url, updated_at: new Date().toISOString() })
          .eq('id', invoice_id);
      }
    } catch {}

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

async function sendWithRetry(draftId, payload, maxAttempts = 6) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await shopifyFetch(`/draft_orders/${draftId}/send_invoice.json`, 'POST', payload);
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes('not finished calculating')) {
        try { await shopifyFetch(`/draft_orders/${draftId}.json`, 'GET'); } catch {}
        await sleep(500 * attempt);
        continue;
      }
      throw e;
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
