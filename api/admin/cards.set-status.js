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
  try {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
      return;
    }

    // admin gate
    const authed = await requireAdmin(req, res);
    if (!authed) return; // requireAdmin already handled the response

    const { card_id, status } = await parseBody(req);
    const to = String(status || '').toLowerCase().trim();
    const id = String(card_id || '').trim();

    if (!id) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'missing_card_id' }));
      return;
    }
    if (!POST_PSA_ALLOWED.has(to)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'invalid_status' }));
      return;
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE
    );

    // Update one card row by id
    const { data, error } = await supabase
      .from('submission_cards')
      .update({ status: to })
      .eq('id', id)
      .select('id'); // return something to confirm the row

    if (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: error.message }));
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, updated: (data?.length || 0) }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err?.message || 'server_error' }));
  }
}
