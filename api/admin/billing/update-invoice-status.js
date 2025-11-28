import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error:"POST only" });

  const { invoice_id, status } = req.body || {};
  if (!invoice_id || !status)
    return res.status(400).json({ error:"Missing invoice_id or status" });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { error } = await supabase
    .from("billing_invoices")
    .update({ status })
    .eq("id", invoice_id);

  if (error) return res.status(500).json({ error });

  return res.json({ ok:true });
}
