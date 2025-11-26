// /api/admin/billing/to-bill.js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../_util/adminAuth.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Utility: coerce a value to a numeric timestamp (ms) or null
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

  // Admin gate (same as other admin endpoints)
  const ok = await requireAdmin(req, res);
  if (!ok) return; // requireAdmin already sent 401

  // Inputs (optional)
  const limit = Math.min(Math.max(Number(req.query.limit) || 800, 1), 2000);
  const q = String(req.query.q || "").trim().toLowerCase();
  const groupFilter = String(req.query.group || "").trim().toLowerCase();
  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to   = req.query.to   ? new Date(String(req.query.to))   : null;
  const fromMs = from && !isNaN(from) ? from.getTime() : null;
  const toMs   = to   && !isNaN(to)   ? to.getTime()   : null;

  // 1) Pull candidate submissions from the admin view (keeps parity with Active UI)
  //    We only want submissions that are back from PSA and not yet fully invoiced.
  //    Columns chosen to avoid over-fetching.
  const { data: subs, error: subsErr } = await supabase
    .from("admin_submissions_v")
    .select("submission_id, status, customer_email, group_code, cards, created_at")
    .eq("status", "received_from_psa")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (subsErr) {
    console.error("[to-bill] subsErr:", subsErr);
    return res.status(500).json({ error: "Failed to read submissions" });
  }

  if (!subs || subs.length === 0) {
    return res.status(200).json({ items: [] });
  }

  // Optional in-memory filters (search / group / date)
  let filtered = subs;
  if (q) {
    filtered = filtered.filter((r) => {
      const hay = [
        r.email,
        r.customer_email,
        r.customer_name,
        r.submission_id,
        r.group_code,
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }
  if (groupFilter) {
    filtered = filtered.filter((r) =>
      String(r.group_code || "").toLowerCase().includes(groupFilter)
    );
  }
  if (fromMs != null || toMs != null) {
    filtered = filtered.filter((r) => {
      const t = ts(r.created_at);
      if (t == null) return false;
      if (fromMs != null && t < fromMs) return false;
      if (toMs   != null && t > toMs)   return false;
      return true;
    });
  }

  // 2) Inspect invoice links:
  //    - Exclude subs linked to invoices in (draft, sent, paid)
  //    - Record subs linked to *pending* invoices so we can group by invoice
  const ids = Array.from(new Set(filtered.map((r) => r.submission_id))).filter(Boolean);

  const exclude = new Set();                 // submission_ids to hide
  const subToPending = new Map();            // submission_id -> pending invoice_id

  if (ids.length) {
    const { data: links, error: linkErr } = await supabase
      .from("billing_invoice_submissions")
      .select("invoice_id, submission_code")
      .in("submission_code", ids);

    if (linkErr) {
      console.error("[to-bill] linkErr:", linkErr);
      // Fail-safe: treat as if there were no links (no exclusion, no pending map)
    } else if (links && links.length) {
      const invoiceIds = Array.from(new Set(links.map((r) => r.invoice_id))).filter(Boolean);

      if (invoiceIds.length) {
        const { data: invs, error: invErr } = await supabase
          .from("billing_invoices")
          .select("id, status")
          .in("id", invoiceIds);

        if (invErr) {
          console.error("[to-bill] invErr:", invErr);
        } else {
          const statusById = new Map();
          for (const inv of invs || []) {
            const st = String(inv?.status || "").toLowerCase();
            statusById.set(inv.id, st);
          }

          // classify each link
          for (const l of links) {
            const st = statusById.get(l.invoice_id);
            if (!st) continue;

            if (["draft", "sent", "paid"].includes(st)) {
              // fully handled → do not show this submission on "To send"
              exclude.add(l.submission_code);
            } else if (st === "pending") {
              // open invoice-in-progress → group by this invoice id
              subToPending.set(l.submission_code, l.invoice_id);
            }
            // other statuses (e.g. cancelled) are treated as "no invoice"
          }
        }
      }
    }
  }

  const eligible = filtered.filter((r) => !exclude.has(r.submission_id));

  // 3) Bundle by invoice (if pending exists) or by customer email
  //    - key = "inv:<invoice_id>" for pending invoices
  //    - key = "cust:<email>"     when no invoice exists yet
  const bundles = new Map();

  for (const r of eligible) {
    const email = (r.customer_email || r.email || "").trim().toLowerCase();
    if (!email) continue; // need an anchor to invoice

    const name = r.customer_name || "";
    const receivedAt = r.created_at || null;
    const pendingId = subToPending.get(r.submission_id) || null;

    const key = pendingId ? `inv:${pendingId}` : `cust:${email}`;

    let b = bundles.get(key);
    if (!b) {
      b = {
        invoice_id: pendingId,  // null = no invoice yet
        customer_email: email,
        customer_name: name,
        submissions: [],
        groups: new Set(),
        cards: 0,
        _newest: null,
        _oldest: null,
      };
      bundles.set(key, b);
    }

    b.submissions.push({
      submission_id: r.submission_id,
      group_code: r.group_code || null,
      cards: Number(r.cards) || 0,
      returned_at: receivedAt,
      invoice_id: pendingId,
    });

    if (r.group_code) b.groups.add(r.group_code);
    b.cards += Number(r.cards) || 0;

    const t = ts(receivedAt);
    if (t != null) {
      if (b._newest == null || t > b._newest) b._newest = t;
      if (b._oldest == null || t < b._oldest) b._oldest = t;
    }
  }

  // 4) Shape output (add aliases & counts for UI)
  const items = Array.from(bundles.values()).map((b) => {
    const submission_ids = (b.submissions || []).map((s) => s.submission_id).filter(Boolean);
    const group_codes = Array.from(b.groups || []);
    return {
      invoice_id: b.invoice_id || null,   // NEW: expose invoice if pending
      customer_email: b.customer_email,
      customer_name: b.customer_name,
      // arrays
      submissions: b.submissions || [],
      submission_ids,
      groups: group_codes,
      group_codes,
      // counts
      submissions_count: submission_ids.length,
      groups_count: group_codes.length,
      // metrics
      cards: b.cards,
      returned_newest: b._newest ? new Date(b._newest).toISOString() : null,
      returned_oldest: b._oldest ? new Date(b._oldest).toISOString() : null,
      // pricing placeholder (filled by front-end estimates)
      estimated_cents: null,
    };
  });

  return res.status(200).json({ items });
}
