// /api/admin/billing/bundle.js
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "GET")
    return res.status(405).json({ error: "GET only" });

  const subsParam = req.query.subs;
  if (!subsParam) return res.status(400).json({ error: "Missing subs param" });

  const submission_ids = subsParam.split(",").map(s => s.trim()).filter(Boolean);
  if (!submission_ids.length)
    return res.status(400).json({ error: "Invalid subs param" });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  /* -----------------------------------------------------------
     1) Load submissions (email, address, etc.)
  ----------------------------------------------------------- */
  const { data: subs, error: subsErr } = await supabase
    .from("psa_submissions")
    .select(`
      submission_id,
      customer_email,
      ship_to_name,
      ship_to_line1,
      ship_to_line2,
      ship_to_city,
      ship_to_region,
      ship_to_postal,
      ship_to_country
    `)
    .in("submission_id", submission_ids);

  if (subsErr) return res.status(500).json({ error: subsErr });

  /* -----------------------------------------------------------
     2) Load groups linked to these submissions
  ----------------------------------------------------------- */
  const { data: grpLinks, error: grpErr } = await supabase
    .from("psa_group_submissions")
    .select("group_code, submission_code")
    .in("submission_code", submission_ids);

  if (grpErr) return res.status(500).json({ error: grpErr });

  const groupCodes = [
    ...new Set(grpLinks.map(r => r.group_code))
  ];

  /* -----------------------------------------------------------
     3) Load existing draft invoice if any
  ----------------------------------------------------------- */
  const { data: draftLink, error: draftErr } = await supabase
    .from("billing_invoice_submissions")
    .select("invoice_id")
    .in("submission_code", submission_ids)
    .limit(1);

  if (draftErr) return res.status(500).json({ error: draftErr });

  const invoice_id = draftLink?.[0]?.invoice_id || null;

  /* -----------------------------------------------------------
     4) If a draft invoice exists, load its upcharges & items
  ----------------------------------------------------------- */
  let upcharges = [];
  if (invoice_id) {
    const { data: upData, error: upErr } = await supabase
      .from("billing_invoice_items")
      .select("card_id, upcharge_cents")
      .eq("invoice_id", invoice_id);

    if (!upErr && upData) upcharges = upData;
  }

  /* -----------------------------------------------------------
     5) Build unified ship-to
        (single address: take first submission's address)
  ----------------------------------------------------------- */
  let ship_to = null;
  if (subs.length > 0) {
    const s = subs[0];
    ship_to = {
      name: s.ship_to_name || "",
      line1: s.ship_to_line1 || "",
      line2: s.ship_to_line2 || "",
      city: s.ship_to_city || "",
      region: s.ship_to_region || "",
      postal: s.ship_to_postal || "",
      country: s.ship_to_country || "US"
    };
  }

  /* -----------------------------------------------------------
     6) Determine customer email (same rule as UI)
  ----------------------------------------------------------- */
  const customer_email = subs[0]?.customer_email || "";

  /* -----------------------------------------------------------
     7) Return unified bundle
  ----------------------------------------------------------- */
  return res.json({
    submissions: submission_ids.map(id => ({ submission_id: id })),
    customer_email,
    groups: groupCodes,
    ship_to,
    invoice_id,
    upcharges
  });
}
