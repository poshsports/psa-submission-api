// /api/debug/shopify-ping.js  (ESM)
// Temporary endpoint to verify your Shopify Admin token & scopes.
// Guarded by the admin cookie so it’s not public.
//
// Usage after deploy:
//   GET /api/debug/shopify-ping
// Returns JSON showing whether the token can read /shop and /draft_orders/count.

import { requireAdmin } from '../_util/adminAuth.js';

const STORE = process.env.SHOPIFY_STORE; // e.g. poshsports.myshopify.com
const TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN; // shpat_...
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-04';

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload, null, 2));
}

async function sfetch(path, method = 'GET', body) {
  const url = `https://${STORE}/admin/api/${API_VERSION}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await resp.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { ok: resp.ok, status: resp.status, data, text };
}

export default async function handler(req, res) {
  if (!requireAdmin(req)) return json(res, 401, { error: 'Unauthorized' });

  if (!STORE || !TOKEN) {
    return json(res, 500, { error: 'Missing SHOPIFY_STORE or SHOPIFY_ADMIN_API_ACCESS_TOKEN' });
  }

  try {
    const shop = await sfetch('/shop.json');
    const draftCount = await sfetch('/draft_orders/count.json'); // tests read_draft_orders scope

    return json(res, 200, {
      env: { store: STORE, api_version: API_VERSION },
      shop: {
        ok: shop.ok, status: shop.status,
        domain: shop.data?.shop?.domain || null,
        name: shop.data?.shop?.name || null,
        error: shop.ok ? null : (shop.data || shop.text)
      },
      draft_orders_read: {
        ok: draftCount.ok, status: draftCount.status,
        count: draftCount.data?.count ?? null,
        error: draftCount.ok ? null : (draftCount.data || draftCount.text)
      }
    });
  } catch (e) {
    return json(res, 500, { error: String(e) });
  }
}
