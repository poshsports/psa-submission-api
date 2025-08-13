// /api/proxy/submissions.js  (ESM)
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
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ ok:false, error:'method_not_allowed' });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');

    // Quick probe to confirm this function runs via the App Proxy
    if (req.query.ping === '1') {
      return res.status(200).json({ ok:true, where:'/api/proxy/submissions', query:req.query });
    }

    // TEMP bypass (works even in prod). Remove after testing.
    const devBypass = req.query.dev_skip_sig === '1';
    if (!devBypass && !verifyProxyHmac(req.query)) {
      return res.status(403).json({ ok:false, error:'invalid_signature' });
    }

    const idRaw =
      req.query.logged_in_customer_id ||
      req.headers['x-shopify-customer-id'] ||
      req.headers['x-shopify-logged-in-customer-id'];

    const idNum = Number(idRaw);
    if (!Number.isFinite(idNum)) {
      return res.status(401).json({ ok:false, error:'not_logged_in' });
    }

    const { data, error } = await supabase
      .from('psa_submissions')
      .select(`
        submission_id,
        created_at,
        submitted_at_iso,
        cards,
        card_count,
        quantity,
        items,
        status,
        totals,
        grading_total,
        amount_cents,
        total,
        number,
        submission_no,
        id,
        ref,
        code,
        shopify_customer_id
      `)
      .eq('shopify_customer_id', String(idNum))
      .order('submitted_at_iso', { ascending: false });

    if (error) {
      console.error('Supabase query error:', error);
      return res.status(500).json({ ok:false, error:'db_error' });
    }

    return res.status(200).json({ ok:true, customerId:String(idNum), submissions: data || [] });
  } catch (e) {
    console.error('proxy/submissions error', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
}
