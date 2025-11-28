// /api/admin/billing/to-bill.js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../_util/adminAuth.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ts = (v) => {
  if (!v) return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const ok = await requireAdmin(req, res);
  if (!ok) return;

  // ================================
  // 1) FETCH INVOICES (SPLIT MODE)
  // ================================
  const { data: invoices, error: invErr } = await supabase
    .from("billing_invoices")
    .select(`
      id,
      status,
      customer_email,
      subtotal_cents,
      total_cents,
      metadata,
      created_at
    `)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (invErr) {
    console.error("[to-bill] invErr:", invErr);
    return res.status(500).json({ error: "Failed to read invoices" });
  }

  // If invoice mode has rows → return invoice rows ONLY
  if (invoices && invoices.length > 0) {
    const invoiceIds = invoices.map((i) => i.id);

    const { data: links, error: linkErr } = await supabase
      .from("billing_invoice_submissions")
      .select("invoice_id, submission_code")
      .in("invoice_id", invoiceIds);

    if (linkErr) {
      console.error("[to-bill] linkErr:", linkErr);
      return res.status(500).json({ error: "Failed to read invoice links" });
    }

    // Build map
    const map = new Map();
    for (const inv of invoices) {
      map.set(inv.id, {
        invoice_id: inv.id,
        customer_email: inv.customer_email,
        submissions: [],
        submission_ids: [],
        groups: new Set(),
        cards: 0,
        returned_newest: null,
        returned_oldest: null,
        estimated_cents: inv.total_cents,
        is_split: inv.metadata?.is_split === true
      });
    }

    // Fetch submission info
    const codes = links.map((l) => l.submission_code);
    const { data: subs } = await supabase
      .from("admin_submissions_v")
      .select("submission_id, group_code, cards, created_at")
      .in("submission_id", codes);

    const byId = new Map();
    for (const s of subs || []) byId.set(s.submission_id, s);

    // Fill bundles
    for (const l of links) {
      const b = map.get(l.invoice_id);
      const s = byId.get(l.submission_code);
      if (!b || !s) continue;

      b.submission_ids.push(s.submission_id);
      b.submissions.push({
        submission_id: s.submission_id,
        group_code: s.group_code,
        cards: s.cards,
      });

      b.cards += Number(s.cards) || 0;
      if (s.group_code) b.groups.add(s.group_code);

      const t = ts(s.created_at);
      if (t != null) {
        if (!b.returned_newest || t > b.returned_newest) b.returned_newest = t;
        if (!b.returned_oldest || t < b.returned_oldest) b.returned_oldest = t;
      }
    }

    const items = [...map.values()].map((b) => ({
      ...b,
      group_codes: Array.from(b.groups),
      groups: b.groups,
    }));

    return res.status(200).json({ items });
  }

  // ===========================================================
  // 2) NO INVOICES → ORIGINAL "RECEIVED-FROM-PSA" COMBINED MODE
  // ===========================================================
  const { data: submissions, error: subErr } = await supabase
    .from("admin_submissions_v")
    .select("submission_id, customer_email, group_code, cards, returned_at, status")
    .eq("status", "received_from_psa"); // ORIGINAL LOGIC

  if (subErr) {
    console.error("[to-bill] subsErr:", subErr);
    return res.status(500).json({ error: "Failed to read submissions" });
  }

  if (!submissions || submissions.length === 0) {
    return res.status(200).json({ items: [] });
  }

  // Group by customer
  const grouped = new Map();

  for (const s of submissions) {
    if (!grouped.has(s.customer_email)) {
      grouped.set(s.customer_email, {
        customer_email: s.customer_email,
        submissions: [],
        submission_ids: [],
        groups: new Set(),
        cards: 0,
        returned_newest: null,
        returned_oldest: null,
        is_split: false // combined mode
      });
    }

    const b = grouped.get(s.customer_email);
    b.submission_ids.push(s.submission_id);
    b.submissions.push(s);

    b.groups.add(s.group_code);
    b.cards += Number(s.cards) || 0;

    const t = ts(s.returned_at);
    if (t != null) {
      if (!b.returned_newest || t > b.returned_newest) b.returned_newest = t;
      if (!b.returned_oldest || t < b.returned_oldest) b.returned_oldest = t;
    }
  }

  const items = [...grouped.values()].map((b) => ({
    ...b,
    group_codes: Array.from(b.groups),
    groups: b.groups,
  }));

  return res.status(200).json({ items });
}
