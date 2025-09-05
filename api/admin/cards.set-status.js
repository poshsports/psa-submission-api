// api/admin/cards.set-status.js
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '../_util/adminAuth.js';

const POST_PSA_ALLOWED = new Set([
  'received_from_psa',
  'balance_due',
  'paid',
  'shipped_to_customer',
  'delivered',
]);

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({}); }
    });
  });
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
      return;
    }

    // admin gate
    const authed = await requireAdmin(req, res);
    if (!authed) return; // requireAdmin already wrote response if blocked

    const { card_id, status } = await parseBody(req);
    const to = String(status || '').toLowerCase().trim();
    const id = String(card_id || '').trim();

    if (!id) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'missing_card_id' }));
      return;
    }
    if (!POST_PSA_ALLOWED.has(to)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'invalid_status' }));
      return;
    }

    // -------- Robust Supabase env lookup --------
    const SUPABASE_URL =
      process.env.SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      process.env.PUBLIC_SUPABASE_URL ||
      process.env.VITE_SUPABASE_URL;

    // Prefer a server-only service key; fall back to anon only if that’s what the project uses.
    const SUPABASE_KEY =
      process.env.SUPABASE_SERVICE_ROLE ||     // recommended
      process.env.SUPABASE_SERVICE_KEY ||      // common alt name
      process.env.SUPABASE_SECRET ||           // some templates
      process.env.SUPABASE_KEY ||              // generic
      process.env.SUPABASE_ANON_KEY ||         // last-resort (if your RLS allows it)
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!SUPABASE_URL) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: 'Missing SUPABASE_URL env' }));
      return;
    }
    if (!SUPABASE_KEY) {
      res.statusCode = 500;
      res.end(JSON.stringify({
        ok: false,
        error:
          'Missing Supabase key env. Set SUPABASE_SERVICE_ROLE (or SUPABASE_SERVICE_KEY / SUPABASE_KEY / SUPABASE_ANON_KEY).',
      }));
      return;
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    });

    // Update one card row by id
    const { data, error } = await supabase
      .from('submission_cards') // <-- If your table name differs, change this.
      .update({ status: to })
      .eq('id', id)
      .select('id'); // return something to confirm the row

    if (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: error.message }));
      return;
    }

    res.end(JSON.stringify({ ok: true, updated: (data?.length || 0) }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: err?.message || 'server_error' }));
  }
}
