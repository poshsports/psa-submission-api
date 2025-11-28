import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error:"POST only" });

  const { submission_id } = req.body || {};
  if (!submission_id) return res.status(400).json({ error:"Missing submission_id" });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data, error } = await supabase
    .from("billing_invoice_submissions")
    .select("invoice_id")
    .eq("submission_code", submission_id)
    .limit(1);

  if (error) return res.status(500).json({ error });

  return res.json({ invoice_id: data?.[0]?.invoice_id || null });
}
