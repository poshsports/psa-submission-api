// /api/proxy/submissions.js
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const { SHOPIFY_API_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function verifyProxyHmac(query = {}) {
  const { signature, ...rest } = query;
  const msg = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(msg).digest('hex');
  return digest === signature;
}

export default async function handler(req, res) {
  try {
    if (req.query.ping === '1') {
      return res.json({ ok: true, where: '/api/proxy/submissions', query: req.query });
    }

    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');

    const devBypass = req.query.dev_skip_sig === '1';
    if (!devBypass && !verifyProxyHmac(req.query)) {
      return res.status(403).json({ ok: false, error: 'invalid_signature' });
    }

    // Customer id from Shopify (force to string to match TEXT or BIGINT columns)
    const customerIdRaw =
      req.query.logged_in_customer_id ||
      req.headers['x-shopify-customer-id'] ||
      req.headers['x-shopify-logged-in-customer-id'];
    const customerId = String(customerIdRaw || '');
    if (!customerId) return res.status(401).json({ ok: false, error: 'not_logged_in' });

    // Select everything, then map to the shape the UI needs
    const { data, error } = await supabase
      .from('psa_submissions')
      .select('*')
      .eq('shopify_customer_id', customerId)
      .order('submitted_at_iso', { ascending: false });

    if (error) {
      console.error('Supabase query error:', error);
      return res.status(500).json({ ok: false, error: 'db_error', code: error.code });
    }

    const submissions = (data || []).map(r => ({
      id: r.submission_no || r.number || r.ref || r.code || r.submission_id || r.id,
      created_at: r.submitted_at_iso || r.created_at,
      cards:
        r.cards ??
        r.card_count ??
        r.quantity ??
        (Array.isArray(r.items) ? r.items.length : 0),
      grading_total:
        r.grading_total ??
        (r.totals && (r.totals.grading ?? r.totals.total ?? r.totals.grand)) ??
        (typeof r.amount_cents === 'number' ? r.amount_cents / 100 : 0),
      status: r.status || 'pending',
    }));

    return res.status(200).json({ ok: true, customerId, submissions });
  } catch (e) {
    console.error('proxy/submissions error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}
