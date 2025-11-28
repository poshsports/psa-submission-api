// /api/admin/billing/to-bill.js
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '../../_util/adminAuth.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Utility: coerce to timestamp (ms) or null
const ts = (v) => {
  if (!v) return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const ok = await requireAdmin(req, res);
  if (!ok) return;

  const limit = Math.min(Math.max(Number(req.query.limit) || 800, 1), 2000);
  const q = String(req.query.q || '').trim().toLowerCase();
  const groupFilter = String(req.query.group || '').trim().toLowerCase();

  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to   = req.query.to   ? new Date(String(req.query.to))   : null;
  const fromMs = from && !isNaN(from) ? from.getTime() : null;
  const toMs   = to   && !isNaN(to)   ? to.getTime()   : null;

  // ---------------------------------------------------------------------------
  // 1) Find submissions that are ready to bill (received_from_psa)
  // ---------------------------------------------------------------------------
  const { data: subs, error: subsErr } = await supabase
    .from('admin_submissions_v')
    .select('submission_id, customer_email, group_code, cards, created_at, returned_at, status')
    .eq('status', 'received_from_psa')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (subsErr) {
    console.error('[to-bill] subsErr:', subsErr);
    return res.status(500).json({ error: 'Failed to read submissions' });
  }

  if (!subs || subs.length === 0) {
    return res.status(200).json({ items: [] });
  }

  // ---------------------------------------------------------------------------
  // 2) Exclude submissions already attached to an open invoice
  // ---------------------------------------------------------------------------
  const { data: openInvoices, error: invErr } = await supabase
    .from('billing_invoices')
    .select('id, status')
    .in('status', ['pending', 'draft', 'sent']);

  if (invErr) {
    console.error('[to-bill] invErr:', invErr);
    return res.status(500).json({ error: 'Failed to read invoices' });
  }

  let billedSet = new Set();
  if (openInvoices && openInvoices.length) {
    const ids = openInvoices.map((i) => i.id);
    const { data: links, error: linkErr } = await supabase
      .from('billing_invoice_submissions')
      .select('submission_code, invoice_id')
      .in('invoice_id', ids);

    if (linkErr) {
      console.error('[to-bill] linkErr:', linkErr);
      // If this fails, just treat as "nothing billed yet" rather than nuking list
    } else {
      (links || []).forEach((l) => {
        if (l.submission_code) billedSet.add(l.submission_code);
      });
    }
  }

  const eligibleSubs = subs.filter(
    (s) => !!s.submission_id && !billedSet.has(s.submission_id)
  );

  if (!eligibleSubs.length) {
    return res.status(200).json({ items: [] });
  }

  // ---------------------------------------------------------------------------
  // 3) Group by customer_email → bundles (this is what Billing "To send" shows)
  // ---------------------------------------------------------------------------
  const bundlesByEmail = new Map();

  for (const s of eligibleSubs) {
    const email = (s.customer_email || '').trim().toLowerCase();
    if (!email) continue;

    if (!bundlesByEmail.has(email)) {
      bundlesByEmail.set(email, {
        customer_email: email,
        customer_name: '',
        submissions: [],
        groups: new Set(),
        cards: 0,
        _newest: null,
        _oldest: null,
        estimated_cents: null
      });
    }

    const b = bundlesByEmail.get(email);
    const when = ts(s.returned_at || s.created_at);

    b.submissions.push({
      submission_id: s.submission_id,
      group_code: s.group_code,
      cards: Number(s.cards) || 0,
      returned_at: s.returned_at || s.created_at
    });

    if (s.group_code) b.groups.add(s.group_code);
    b.cards += Number(s.cards) || 0;

    if (when != null) {
      if (b._newest == null || when > b._newest) b._newest = when;
      if (b._oldest == null || when < b._oldest) b._oldest = when;
    }
  }

  let bundles = Array.from(bundlesByEmail.values());

  // ---------------------------------------------------------------------------
  // 4) In-memory filters (search, group, date) – same UX as before
  // ---------------------------------------------------------------------------
  if (q) {
    bundles = bundles.filter((b) => {
      const hay = [
        b.customer_email,
        ...b.submissions.map((s) => s.submission_id),
        ...Array.from(b.groups || [])
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  if (groupFilter) {
    bundles = bundles.filter((b) =>
      Array.from(b.groups || []).some((g) =>
        String(g || '').toLowerCase().includes(groupFilter)
      )
    );
  }

  if (fromMs != null || toMs != null) {
    bundles = bundles.filter((b) => {
      const t = b._newest;
      if (t == null) return false;
      if (fromMs != null && t < fromMs) return false;
      if (toMs   != null && t > toMs)   return false;
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // 5) Shape response exactly like the old endpoint so the frontend still works
  // ---------------------------------------------------------------------------
  const items = bundles.map((b) => {
    const submission_ids = (b.submissions || []).map((s) => s.submission_id);
    const group_codes = Array.from(b.groups || []);

    return {
      customer_email: b.customer_email,
      customer_name: b.customer_name,
      submissions: b.submissions || [],
      submission_ids,
      groups: b.groups,
      group_codes,
      submissions_count: submission_ids.length,
      groups_count: group_codes.length,
      cards: b.cards,
      returned_newest: b._newest ? new Date(b._newest).toISOString() : null,
      returned_oldest: b._oldest ? new Date(b._oldest).toISOString() : null,
      estimated_cents: b.estimated_cents // null for now; JS will fill via addServerEstimates
    };
  });

  return res.status(200).json({ items });
}
