// /api/admin/billing/preview/prefill.js
import { sb } from '../../../_util/supabase.js';
import { requireAdmin } from '../../../_util/adminAuth.js';

const uniq = (arr) => Array.from(new Set(arr));

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') { res.setHeader('Allow','GET'); return res.status(405).json({ error:'Method not allowed' }); }
    if (!requireAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });

    const raw = String(req.query.subs || '').trim();
    const subCodes = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (!subCodes.length) return res.status(200).json({ invoice_id: null, items: [] });

    const client = sb();

    // A) Try to reuse via existing links to an open invoice
    const { data: links, error: linkErr } = await client
      .from('billing_invoice_submissions')
      .select('invoice_id')
      .in('submission_code', subCodes);
    if (linkErr) return res.status(500).json({ error: 'Failed to read invoice links', details: linkErr.message });

    let invoice_id = null;

    if (links?.length) {
      const invIds = uniq(links.map(l => l.invoice_id));
      const { data: invs, error: invErr } = await client
        .from('billing_invoices')
        .select('id, status, updated_at')
        .in('id', invIds)
        .in('status', ['pending','draft'])
        .order('updated_at', { ascending: false });
      if (invErr) return res.status(500).json({ error: 'Failed to read invoices', details: invErr.message });
      if (invs?.length) invoice_id = invs[0].id;
    }

    // B) Fallback: by (shopify_customer_id, group_code)
    if (!invoice_id) {
      const { data: subs, error: subsErr } = await client
        .from('psa_submissions')
        .select('submission_id, shopify_customer_id')
        .in('submission_id', subCodes);
      if (subsErr) return res.status(500).json({ error: 'Failed to fetch submissions', details: subsErr.message });

      const shopIds = uniq((subs || []).map(s => s.shopify_customer_id).filter(Boolean));
      const shopify_customer_id = shopIds[0] || null;

      let group_code = 'MULTI';
      const { data: gs, error: gsErr } = await client
        .from('group_submissions')
        .select('group_id, submission_id')
        .in('submission_id', subCodes);
      if (gsErr) return res.status(500).json({ error: 'Failed to fetch group_submissions', details: gsErr.message });

      if (gs?.length) {
        const groupIds = uniq(gs.map(g => g.group_id).filter(Boolean));
        if (groupIds.length) {
          const { data: grps, error: gErr } = await client
            .from('groups')
            .select('id, code')
            .in('id', groupIds);
          if (gErr) return res.status(500).json({ error: 'Failed to fetch groups', details: gErr.message });
          const codes = uniq((grps || []).map(g => g.code).filter(Boolean));
          if (codes.length === 1) group_code = codes[0];
        }
      }

      if (shopify_customer_id) {
        const { data: invs2, error: inv2Err } = await client
          .from('billing_invoices')
          .select('id, updated_at')
          .eq('shopify_customer_id', shopify_customer_id)
          .eq('group_code', group_code)
          .in('status', ['pending','draft'])
          .order('updated_at', { ascending: false })
          .limit(1);
        if (inv2Err) return res.status(500).json({ error: 'Failed to read open invoice by customer/group', details: inv2Err.message });
        if (invs2 && invs2.length) invoice_id = invs2[0].id;
      }
    }

    if (!invoice_id) return res.status(200).json({ invoice_id: null, items: [] });

    // C) Pull per-card saved values from the view
    const { data: rows, error: vErr } = await client
      .from('billing_invoice_cards_v')
      .select('submission_card_id, grading_cents, upcharge_cents')
      .eq('invoice_id', invoice_id);
    if (vErr) return res.status(500).json({ error: 'Failed to read invoice items', details: vErr.message });

    const items = (rows || []).map(r => ({
      card_id: r.submission_card_id,
      grading_cents: r.grading_cents || 0,
      upcharge_cents: r.upcharge_cents || 0
    }));

    return res.status(200).json({ invoice_id, items });
  } catch (err) {
    console.error('[preview/prefill] error', err);
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
