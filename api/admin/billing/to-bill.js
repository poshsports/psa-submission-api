// /api/admin/billing/to-bill.js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../_util/adminAuth.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Helpers
function pickReceivedAt(row) {
  return row.last_updated_at || row.created_at || null;
}

function isNewer(a, b) {
  if (!a) return false;
  if (!b) return true;
  const na = Date.parse(a);
  const nb = Date.parse(b);
  if (Number.isNaN(na)) return false;
  if (Number.isNaN(nb)) return true;
  return na > nb;
}

function isOlder(a, b) {
  if (!a) return false;
  if (!b) return true;
  const na = Date.parse(a);
  const nb = Date.parse(b);
  if (Number.isNaN(na)) return false;
  if (Number.isNaN(nb)) return true;
  return na < nb;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const ok = await requireAdmin(req, res);
  if (!ok) return;

  const tab = (req.query.tab || "to-send").toString();

  // ======================================================
  // 1) LOAD PENDING INVOICES (unchanged)
  // ======================================================

  let invoiceBundles = [];
  let invoiceAttachedSubIds = new Set();

  try {
    const { data: invoices, error: invErr } = await supabase
      .from("billing_invoices")
      .select(`
        id,
        status,
        group_code,
        subtotal_cents,
        shipping_cents,
        discount_cents,
        tax_cents,
        total_cents,
        created_at
      `)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (!invErr && invoices?.length) {
      const invoiceIds = invoices.map((i) => i.id);

      const { data: links } = await supabase
        .from("billing_invoice_submissions")
        .select("invoice_id, submission_code")
        .in("invoice_id", invoiceIds);

      const subCodes = [...new Set(links?.map((l) => l.submission_code) || [])];
      invoiceAttachedSubIds = new Set(subCodes);

      const { data: subs } = await supabase
        .from("admin_submissions_v")
        .select(
          "submission_id, customer_email, group_code, cards, created_at, last_updated_at, status"
        )
        .in("submission_id", subCodes);

      const lookup = new Map(subs?.map((s) => [s.submission_id, s]) || []);

      const bundles = new Map();
      for (const inv of invoices) {
        bundles.set(inv.id, {
          invoice_id: inv.id,
          customer_email: null,
          submissions: [],
          submission_ids: [],
          groupsSet: new Set(),
          cards: 0,
          returned_newest: null,
          returned_oldest: null,
          estimated_cents:
            inv.total_cents ??
            (inv.subtotal_cents ?? 0) +
              (inv.shipping_cents ?? 0) -
              (inv.discount_cents ?? 0) +
              (inv.tax_cents ?? 0),
          is_split: (inv.group_code || "").includes("-SPLIT-"),
        });
      }

      for (const l of links || []) {
        const b = bundles.get(l.invoice_id);
        const s = lookup.get(l.submission_code);
        if (!b || !s) continue;

        b.submission_ids.push(s.submission_id);
        b.submissions.push(s);
        if (!b.customer_email) b.customer_email = s.customer_email;

        if (s.group_code) b.groupsSet.add(s.group_code);
        b.cards += Number(s.cards) || 0;

        const dt = pickReceivedAt(s);
        if (dt) {
          if (isNewer(dt, b.returned_newest)) b.returned_newest = dt;
          if (isOlder(dt, b.returned_oldest)) b.returned_oldest = dt;
        }
      }

      invoiceBundles = [...bundles.values()].map((b) => ({
        invoice_id: b.invoice_id,
        customer_email: b.customer_email,
        submissions: b.submissions,
        submission_ids: b.submission_ids,
        groups: [...b.groupsSet],
        group_codes: [...b.groupsSet],
        cards: b.cards,
        returned_newest: b.returned_newest,
        returned_oldest: b.returned_oldest,
        estimated_cents: b.estimated_cents,
        is_split: b.is_split,
      }));
    }
  } catch (err) {
    console.warn("[to-bill] invoice section error:", err);
  }

   // ======================================================
  // 2) NEW BILLABLE ROWS — DIRECTLY FROM THE VIEW
  // ======================================================

  let emailBundles = [];

  try {
    const { data: rows, error: rowErr } = await supabase
      .from("billing_to_bill_v")
      .select("*");

    if (rowErr) {
      console.error("[to-bill] SQL view error:", rowErr);
      return res.status(500).json({ error: "Failed to load billing_to_bill_v" });
    }

    for (const r of rows) {
      const subs = Array.isArray(r.submissions) ? r.submissions : [];

      // Only keep submissions NOT already attached
      const unattachedSubs = [];
      const unattachedIds  = [];

      for (const s of subs) {
        const sid = s.submission_id;
        if (!sid) continue;
        if (invoiceAttachedSubIds.has(sid)) continue;
        unattachedSubs.push(s);
        unattachedIds.push(sid);
      }

      // Skip if all submissions were already attached
      if (!unattachedIds.length) continue;

      // Compute cards + received timestamps
      let cards = 0;
      let returnedNewest = null;
      let returnedOldest = null;

      for (const s of unattachedSubs) {
        cards += Number(s.cards) || 0;

        const dt = pickReceivedAt(s);
        if (dt) {
          if (isNewer(dt, returnedNewest)) returnedNewest = dt;
          if (isOlder(dt, returnedOldest)) returnedOldest = dt;
        }
      }

      // Push NEW billable bundle
      emailBundles.push({
        invoice_id: null,
        customer_email: r.customer_email,
        submissions: unattachedSubs,
        submission_ids: unattachedIds,

        // FIX: include groups
        groups: Array.isArray(r.groups)
          ? r.groups
          : (r.group_code ? [r.group_code] : []),

        group_codes: Array.isArray(r.groups)
          ? r.groups
          : (r.group_code ? [r.group_code] : []),

        cards,
        returned_newest: returnedNewest,
        returned_oldest: returnedOldest,
        estimated_cents: null,
        is_split: false,

        address: r.address,
        normalized_address_key: r.normalized_address_key,

        // FIX: build ship_to for Invoice Builder
        ship_to: (function () {
          try {
            if (!r.address) return null;
            const raw = typeof r.address === "string"
              ? JSON.parse(r.address)
              : r.address;
            if (!raw || typeof raw !== "object") return null;

            return {
              name: raw.name || raw.full_name || raw.contact || "",
              line1: raw.line1 || raw.street || raw.address1 || "",
              line2: raw.line2 || raw.address2 || "",
              city: raw.city || "",
              region: raw.region || raw.state || "",
              postal: raw.postal || raw.zip || "",
              country: raw.country || "US",
            };
          } catch {
            return null;
          }
        })()
      });
    } // <-- closes for-loop
  } catch (err) {
    console.error("[to-bill] address/view grouping error:", err);
  }


  // ======================================================
  // 3) FINAL RESULT
  // ======================================================
  return res.status(200).json({
    items: [...invoiceBundles, ...emailBundles],
  });
}
