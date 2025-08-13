// /api/proxy/submissions.js  (ESM)
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const {
  SHOPIFY_API_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function verifyProxyHmac(query = {}) {
  const { signature, ...rest } = query;
  const msg = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(msg).digest('hex');
  return digest === signature;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');

    if (req.query.ping) {
      return res.status(200).json({
        ok: true,
        where: '/api/proxy/submissions',
        query: req.query,
      });
    }

    const devBypass =
      process.env.NODE_ENV !== 'production' && req.query.dev_skip_sig === '1';
    if (!devBypass && !verifyProxyHmac(req.query)) {
      return res.status(403).json({ ok: false, error: 'invalid_signature' });
    }

    const customerIdRaw =
      req.query.logged_in_customer_id ||
      req.headers['x-shopify-customer-id'] ||
      req.headers['x-shopify-logged-in-customer-id'];

    const customerIdNum = Number(customerIdRaw);
    if (!Number.isFinite(customerIdNum)) {
      return res.status(401).json({ ok: false, error: 'not_logged_in' });
    }

    // ✅ Only columns we’re sure exist
    const { data, error } = await supabase
      .from('psa_submissions')
      .select(`
        id,
        submission_id,
        code,
        created_at,
        submitted_at_iso,
        cards,
        status,
        totals,
        shopify_customer_id
      `)
      .eq('shopify_customer_id', customerIdNum)
      .order('submitted_at_iso', { ascending: false });

    if (error) {
      console.error('Supabase query error:', error);
      return res.status(500).json({ ok: false, error: 'db_error' });
    }

    const submissions = (data || []).map(r => ({
      // Friendly display order: submission_id → code → UUID
      id: r.submission_id || r.code || r.id,
      created_at: r.submitted_at_iso || r.created_at,
      cards: r.cards ?? 0,
      grading_total: r?.totals?.grading ?? null,
      status: r.status || 'received',
      totals: r.totals || null,
    }));

    return res.status(200).json({
      ok: true,
      customerId: String(customerIdNum),
      submissions,
    });
  } catch (e) {
    console.error('proxy/submissions error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}
