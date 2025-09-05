// api/admin/cards.set-status.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const ALLOWED = new Set([
  'received_from_psa',
  'balance_due',
  'paid',
  'shipped_to_customer',
  'delivered'
]);

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return {}; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.json({ ok: false, error: 'method_not_allowed' });
  }

  // (Optionally enforce your admin cookie/guard here if you do that elsewhere.)
  const { card_id, status } = await readJson(req);

  if (!card_id) return res.status(400).json({ ok: false, error: 'card_id_required' });
  if (!status || !ALLOWED.has(String(status).toLowerCase())) {
    return res.status(400).json({ ok: false, error: 'invalid_status' });
  }

  const { error } = await sb
    .from('psa_cards')
    .update({ status })
    .eq('id', String(card_id));

  if (error) return res.status(500).json({ ok: false, error: error.message });

  return res.json({ ok: true });
}
