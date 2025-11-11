// /api/admin/billing/split-by-address.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

type ShipAddr = {
  name?: string; contact?: string; full_name?: string; first_last?: string; attn?: string;
  line1?: string; address1?: string; addr1?: string; street?: string;
  line2?: string; address2?: string; addr2?: string;
  city?: string; region?: string; state?: string; province?: string;
  postal?: string; zip?: string; postal_code?: string; postcode?: string;
  country?: string;
};

type SubmissionResp = {
  ok?: boolean;
  item?: {
    submission_id: string;
    shipping_address?: ShipAddr;
    // ... other fields not used here
  };
};

type CardsPreviewRow = {
  id?: string; card_id?: string;
  // ...other fields not needed; we only need an id to produce a save item
};

function normAddr(a?: ShipAddr | null) {
  if (!a) return null;
  const name   = (a.name ?? a.contact ?? a.full_name ?? a.first_last ?? a.attn ?? '').trim();
  const line1  = (a.line1 ?? a.address1 ?? a.addr1 ?? a.street ?? '').trim();
  const line2  = (a.line2 ?? a.address2 ?? a.addr2 ?? '').trim();
  const city   = (a.city ?? '').trim();
  const region = (a.region ?? a.state ?? a.province ?? '').trim();
  const postal = String(a.postal ?? a.zip ?? a.postal_code ?? a.postcode ?? '').trim();
  const country= (a.country ?? 'US').trim();

  // if absolutely nothing, skip
  if (!name && !line1 && !line2 && !city && !region && !postal && !country) return null;

  return { name, line1, line2, city, region, postal, country };
}

function addrKey(a: ReturnType<typeof normAddr>) {
  if (!a) return '∅';
  return JSON.stringify({
    n: a.name.toLowerCase(),
    l1: a.line1.toLowerCase(),
    l2: a.line2.toLowerCase(),
    c: a.city.toLowerCase(),
    r: a.region.toLowerCase(),
    p: a.postal,
    co: a.country.toLowerCase(),
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const { subs, email } = (req.body || {}) as { subs?: string[]; email?: string };
  if (!Array.isArray(subs) || subs.length === 0) return res.status(400).json({ ok: false, error: 'Missing subs[]' });
  if (!email || typeof email !== 'string')       return res.status(400).json({ ok: false, error: 'Missing email' });

  try {
    // Build an absolute base URL to call sibling endpoints on this same deployment
    const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
    const host  = (req.headers['x-forwarded-host']  as string) || (req.headers.host as string);
    const base  = `${proto}://${host}`;

    // 1) Load shipping address per submission, group by normalized address
    const groups = new Map<string, { addr: ReturnType<typeof normAddr>, subs: string[] }>();

    for (const id of subs) {
      const r = await fetch(`${base}/api/admin/submission?id=${encodeURIComponent(id)}&full=1`, {
        headers: { 'accept': 'application/json' },
        // same-origin cookie/headers flow is preserved on server by default
      });
      if (!r.ok) continue;
      const j = (await r.json()) as SubmissionResp;
      const addr = normAddr(j?.item?.shipping_address ?? null);
      const key  = addrKey(addr);
      if (!groups.has(key)) groups.set(key, { addr, subs: [] });
      groups.get(key)!.subs.push(id);
    }

    // 2) For each address group, fetch cards and create a brand-new draft by calling preview/save w/out invoice_id
    const createdInvoiceIds: string[] = [];

    for (const [, g] of groups) {
      // cards for just this subset
      const qs   = new URLSearchParams({ subs: g.subs.join(',') }).toString();
      const cr   = await fetch(`${base}/api/admin/billing/cards-preview?${qs}`, {
        headers: { 'accept': 'application/json' },
      });
      if (!cr.ok) continue;
      const cj = await cr.json().catch(() => ({} as { rows?: CardsPreviewRow[] }));
      const rows = Array.isArray(cj?.rows) ? (cj.rows as CardsPreviewRow[]) : [];

      // Minimal items payload: we only need a card id + upcharge cents (default 0)
      const items = rows.map(r => {
        const id = String((r.card_id ?? r.id) || '');
        return id ? { card_id: id, upcharge_cents: 0 } : null;
      }).filter(Boolean);

      if (items.length === 0) continue;

      // If your preview/save endpoint supports ship-to, you can add it to the body as `ship_to: g.addr`
      // Otherwise, address will be handled/displayed at send time/Shopify.
      const body = { customer_email: email, items /* , ship_to: g.addr */ };

      const sr = await fetch(`${base}/api/admin/billing/preview/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!sr.ok) continue;

      const sj = await sr.json().catch(() => ({} as { invoice_id?: string }));
      if (sj?.invoice_id) createdInvoiceIds.push(sj.invoice_id);
    }

    return res.status(200).json({ ok: true, created: createdInvoiceIds.length, invoice_ids: createdInvoiceIds });
  } catch (err: any) {
    console.error('[split-by-address] error', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
