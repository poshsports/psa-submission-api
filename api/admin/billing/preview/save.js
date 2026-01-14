// /api/admin/billing/preview/save.js  (ESM)
// Save upcharges ONLY (no invoice creation, no invoice items, no links)

import { sb } from '../../../_util/supabase.js';
import { requireAdmin } from '../../../_util/adminAuth.js';

async function readBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(Buffer.from(ch));
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

const uniq = (arr) => Array.from(new Set(arr));

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(res, 405, { error: 'Method not allowed' });
    }
    const ok = await requireAdmin(req, res);
    if (!ok) return; // requireAdmin already sent the 401


   const body = await readBody(req);
const items = Array.isArray(body?.items) ? body.items : [];
const invoiceId = body?.invoice_id || null;
const email = body?.customer_email || null;
const subs = Array.isArray(body?.subs) ? body.subs : [];

// If this is a "Send" path (no items, no invoice yet), create an empty invoice shell
if (!items.length && !invoiceId) {
  if (!email || !subs.length) {
    return json(res, 400, { error: 'Missing email or subs for auto-create' });
  }

  const client = sb();
  const { data: inv, error: invErr } = await client
    .from('billing_invoices')
    .insert({
      customer_email: email,
      status: 'pending'
    })
    .select('id')
    .single();

  if (invErr || !inv) {
    return json(res, 500, { error: 'Failed to create invoice shell' });
  }

  return json(res, 200, { ok: true, invoice_id: inv.id });
}

if (!items.length) return json(res, 400, { error: 'No items to save' });


    // Normalize inputs
    const rows = [];
    for (const it of items) {
      const id = String(it?.card_id || '').trim();
      if (!id) continue;

      const up = Math.max(0, Math.round(Number(it?.upcharge_cents || 0)));
      rows.push({ id, upcharge_cents: up });
    }

    if (!rows.length) return json(res, 400, { error: 'No valid card IDs' });

    // Optional: ensure all card IDs exist (keeps behavior predictable)
    const ids = uniq(rows.map(r => r.id));
    const client = sb();

    const { data: existing, error: exErr } = await client
      .from('submission_cards')
      .select('id')
      .in('id', ids);

    if (exErr) {
      return json(res, 500, { error: 'Failed to validate card IDs', details: exErr.message });
    }

    const got = new Set((existing || []).map(r => r.id));
    const missing = ids.filter(x => !got.has(x));
    if (missing.length) {
      return json(res, 400, { error: 'Some cards not found', missing });
    }

    // Update upcharges (sequential updates are fine at this scale; keeps errors localized)
    let updated = 0;
    for (const r of rows) {
      const { error: upErr } = await client
        .from('submission_cards')
        .update({ upcharge_cents: r.upcharge_cents })
        .eq('id', r.id);

      if (upErr) {
        return json(res, 500, {
          error: 'Failed updating upcharge',
          card_id: r.id,
          details: upErr.message
        });
      }
      updated++;
    }

    return json(res, 200, { ok: true, updated });
  } catch (err) {
    console.error('[preview/save] error', err);
    return json(res, 500, { error: err?.message || String(err) });
  }
}
