// /api/admin/billing/to-bill.js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../_util/adminAuth.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Pick the best "received from PSA" timestamp as a string
function pickReceivedAt(row) {
  // your real schema: last_updated_at is the best proxy
  return row.last_updated_at || row.created_at || null;
}

// Compare two date strings safely using Date.parse
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

  // we only actually have the "to-send" tab here, but keep this for future use
  const tab = (req.query.tab || "to-send").toString();

  // -------------------------------------------------------
  // 1) PENDING INVOICES: one bundle per invoice
  // -------------------------------------------------------
  let invoiceBundles = [];
  let invoiceAttachedSubIds = new Set();

  try {
    // pending = unsent invoices that should appear on the "To send" tab
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
      console.warn("[to-bill] invoice read failed, will fall back to submissions only:", invErr);
    }

    if (Array.isArray(invoices) && invoices.length > 0) {
      const invoiceIds = invoices.map((i) => i.id);

      const { data: links, error: linkErr } = await supabase
        .from("billing_invoice_submissions")
        .select("invoice_id, submission_code")
        .in("invoice_id", invoiceIds);

      if (linkErr) {
        console.error("[to-bill] linkErr (invoice mode):", linkErr);
      } else if (Array.isArray(links) && links.length > 0) {
        const subCodes = links.map((l) => l.submission_code);

        const { data: subs, error: subsErr } = await supabase
          .from("admin_submissions_v")
          .select(
            "submission_id, customer_email, group_code, cards, created_at, last_updated_at, status"
          )
          .in("submission_id", subCodes);

        if (subsErr) {
          console.error("[to-bill] subsErr (invoice mode):", subsErr);
        } else {
          const byId = new Map();
          for (const s of subs || []) {
            byId.set(s.submission_id, s);
          }

          // mark which submissions are already attached to an invoice
          invoiceAttachedSubIds = new Set(subCodes.filter(Boolean));

          const map = new Map();
          for (const inv of invoices) {
            map.set(inv.id, {
              invoice_id: inv.id,
              customer_email: inv.customer_email,
              submissions: [],
              submission_ids: [],
              groupsSet: new Set(),
              cards: 0,
              returned_newest: null,
              returned_oldest: null,
              estimated_cents: inv.total_cents ?? inv.subtotal_cents ?? null,
              is_split: inv.metadata?.is_split === true,
            });
          }

          for (const l of links) {
            const bundle = map.get(l.invoice_id);
            const s = byId.get(l.submission_code);
            if (!bundle || !s) continue;

            bundle.submission_ids.push(s.submission_id);
            bundle.submissions.push({
              submission_id: s.submission_id,
              group_code: s.group_code,
              cards: s.cards,
              created_at: s.created_at,
              last_updated_at: s.last_updated_at,
              status: s.status,
            });

            bundle.cards += Number(s.cards) || 0;
            if (s.group_code) bundle.groupsSet.add(s.group_code);

            const dt = pickReceivedAt(s);
            if (dt) {
              if (isNewer(dt, bundle.returned_newest)) bundle.returned_newest = dt;
              if (isOlder(dt, bundle.returned_oldest)) bundle.returned_oldest = dt;
            }
          }

          invoiceBundles = [...map.values()].map((b) => ({
            invoice_id: b.invoice_id,
            customer_email: b.customer_email,
            submissions: b.submissions,
            submission_ids: b.submission_ids,
            groups: Array.from(b.groupsSet),
            group_codes: Array.from(b.groupsSet),
            cards: b.cards,
            returned_newest: b.returned_newest,
            returned_oldest: b.returned_oldest,
            estimated_cents: b.estimated_cents,
            is_split: b.is_split,
          }));
        }
      }
    }
  } catch (err) {
    console.warn("[to-bill] unexpected invoice mode error:", err);
  }

  // -------------------------------------------------------
  // 2) RAW SUBMISSIONS NOT ATTACHED TO ANY PENDING INVOICE
  //    → group by customer_email (original behavior)
  // -------------------------------------------------------
  let emailBundles = [];

  try {
    const { data: submissions, error: subErr } = await supabase
      .from("admin_submissions_v")
      .select(
        "submission_id, customer_email, group_code, cards, created_at, last_updated_at, status"
      )
      .eq("status", "received_from_psa");

    if (subErr) {
      console.error("[to-bill] subsErr (combined mode):", subErr);
      return res.status(500).json({ error: "Failed to read submissions" });
    }

    if (!submissions || submissions.length === 0) {
      // no submissions at all; just return any invoice bundles we might have
      return res.status(200).json({ items: invoiceBundles });
    }

    const grouped = new Map();

    for (const s of submissions) {
      // If this submission is already on a pending invoice,
      // we do NOT include it in the email-grouped bundles.
      if (invoiceAttachedSubIds.has(s.submission_id)) continue;

      const email = s.customer_email || "";
      if (!grouped.has(email)) {
        grouped.set(email, {
          customer_email: email,
          submissions: [],
          submission_ids: [],
          groupsSet: new Set(),
          cards: 0,
          returned_newest: null,
          returned_oldest: null,
          is_split: false, // these are un-split email bundles
        });
      }

      const b = grouped.get(email);

      b.submission_ids.push(s.submission_id);
      b.submissions.push({
        submission_id: s.submission_id,
        group_code: s.group_code,
        cards: s.cards,
        created_at: s.created_at,
        last_updated_at: s.last_updated_at,
        status: s.status,
      });

      if (s.group_code) b.groupsSet.add(s.group_code);
      b.cards += Number(s.cards) || 0;

      const dt = pickReceivedAt(s);
      if (dt) {
        if (isNewer(dt, b.returned_newest)) b.returned_newest = dt;
        if (isOlder(dt, b.returned_oldest)) b.returned_oldest = dt;
      }
    }

    emailBundles = [...grouped.values()].map((b) => ({
      customer_email: b.customer_email,
      submissions: b.submissions,
      submission_ids: b.submission_ids,
      groups: Array.from(b.groupsSet),
      group_codes: Array.from(b.groupsSet),
      cards: b.cards,
      returned_newest: b.returned_newest,
      returned_oldest: b.returned_oldest,
      is_split: b.is_split,
    }));
  } catch (err) {
    console.error("[to-bill] unexpected combined-mode error:", err);
    // worst case: at least return invoice bundles so the page isn’t blank
    return res.status(200).json({ items: invoiceBundles });
  }

  // -------------------------------------------------------
  // 3) FINAL RESULT
  //    - one row per pending invoice (already split)
  //    - plus one row per customer_email for the rest
  // -------------------------------------------------------
  const items = [...invoiceBundles, ...emailBundles];

  return res.status(200).json({ items });
}
