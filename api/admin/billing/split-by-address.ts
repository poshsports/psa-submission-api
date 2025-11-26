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
    customer_email?: string;
    email?: string;
    shipping_address?: ShipAddr;
    group_code?: string;
  };
};

type CardsPreviewRow = {
  id?: string;
  card_id?: string;
};

type IncomingAddressGroup = {
  addr?: ShipAddr | ReturnType<typeof normAddr> | null;
  subs: string[];
};

function normAddr(a?: ShipAddr | ReturnType<typeof normAddr> | null) {
  if (!a) return null;
  if ('name' in (a as any) && 'line1' in (a as any) && 'city' in (a as any)) {
    const na = a as any;
    const name   = String(na.name ?? '').trim();
    const line1  = String(na.line1 ?? '').trim();
    const line2  = String(na.line2 ?? '').trim();
    const city   = String(na.city ?? '').trim();
    const region = String(na.region ?? '').trim();
    const postal = String(na.postal ?? '').trim();
    const country= String(na.country ?? 'US').trim();
    if (!name && !line1 && !line2 && !city && !region && !postal && !country) return null;
    return { name, line1, line2, city, region, postal, country };
  }
  const sh = a as ShipAddr;
  const name   = (sh.name ?? sh.contact ?? sh.full_name ?? sh.first_last ?? sh.attn ?? '').trim();
  const line1  = (sh.line1 ?? sh.address1 ?? sh.addr1 ?? sh.street ?? '').trim();
  const line2  = (sh.line2 ?? sh.address2 ?? sh.addr2 ?? '').trim();
  const city   = (sh.city ?? '').trim();
  const region = (sh.region ?? sh.state ?? sh.province ?? '').trim();
  const postal = String(sh.postal ?? sh.zip ?? sh.postal_code ?? sh.postcode ?? '').trim();
  const country= (sh.country ?? 'US').trim();
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
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = (req.body || {}) as {
    submissions?: string[];
    addressGroups?: IncomingAddressGroup[];
    customer_email?: string;
    email?: string;
    subs?: string[];
  };

  // normalize subs
  let submissions: string[] | undefined = body.submissions;
  if (!Array.isArray(submissions) || submissions.length === 0) {
    if (Array.isArray(body.subs) && body.subs.length > 0) submissions = body.subs;
  }
  if (!Array.isArray(submissions) || submissions.length === 0) {
    return res.status(400).json({ ok: false, error: 'Missing submissions/subs[]' });
  }

  // normalize email
  let customerEmail: string | undefined =
    (typeof body.customer_email === 'string' && body.customer_email.trim()) ||
    (typeof body.email === 'string' && body.email.trim()) ||
    undefined;

  // Build base URL + pass admin auth headers
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const host  = (req.headers['x-forwarded-host'] as string) || (req.headers.host as string);
  const base  = `${proto}://${host}`;

  const cookie = req.headers.cookie as string | undefined;
  const auth   = req.headers.authorization as string | undefined;
  const xAdmin = req.headers['x-admin-token'] as string | undefined;

  const baseHeaders: Record<string,string> = { accept: 'application/json' };
  if (cookie) baseHeaders.cookie = cookie;
  if (auth) baseHeaders.authorization = auth;
  if (xAdmin) baseHeaders['x-admin-token'] = xAdmin;

  const debug: any = {
    submissions,
    addressGroupsReceived: Array.isArray(body.addressGroups) ? body.addressGroups.length : 0,
    groupDebug: [],
  };

  try {
    // resolve email from first submission
    if (!customerEmail) {
      const firstId = submissions[0];
      const sr = await fetch(
        `${base}/api/admin/submission?id=${encodeURIComponent(firstId)}&full=1`,
        { headers: baseHeaders }
      );
      if (sr.ok) {
        const sj = await sr.json() as SubmissionResp;
        const fromSub = sj?.item?.customer_email || sj?.item?.email;
        if (fromSub) customerEmail = fromSub;
      }
      if (!customerEmail) {
        return res.status(400).json({ ok:false, error:'Missing customer email', debug });
      }
    }

    // ⭐ NEW: fetch original group_code
    let originalGroupCode = 'MULTI';
    try {
      const gr = await fetch(
        `${base}/api/admin/submission?id=${encodeURIComponent(submissions[0])}&full=1`,
        { headers: baseHeaders }
      );
      if (gr.ok) {
        const gj = await gr.json();
        if (gj?.item?.group_code) {
          originalGroupCode = gj.item.group_code;
        }
      }
    } catch (e) {
      console.error('[split] failed to fetch group_code', e);
    }

    // Build address groups
    let groups: { addr: ReturnType<typeof normAddr> | null; subs: string[] }[] = [];

    if (Array.isArray(body.addressGroups) && body.addressGroups.length > 0) {
      groups = body.addressGroups
        .map(g => ({
          addr: normAddr(g.addr ?? null),
          subs: Array.isArray(g.subs) ? g.subs.filter(Boolean) : [],
        }))
        .filter(g => g.subs.length > 0);
    } else {
      const map = new Map<string, { addr: ReturnType<typeof normAddr>; subs: string[] }>();
      for (const id of submissions) {
        const r = await fetch(
          `${base}/api/admin/submission?id=${encodeURIComponent(id)}&full=1`,
          { headers: baseHeaders }
        );
        if (!r.ok) continue;
        const j = await r.json() as SubmissionResp;
        const addr = normAddr(j?.item?.shipping_address ?? null);
        const key  = addrKey(addr);
        if (!map.has(key)) map.set(key, { addr, subs: [] });
        map.get(key)!.subs.push(id);
      }
      groups = [...map.values()];
    }

    if (!groups.length) groups = [{ addr: null, subs: submissions }];
    debug.groupCount = groups.length;

    const created: { invoice_id: string; subs: string[] }[] = [];

    // Loop each group = 1 new invoice
    for (const g of groups) {
      const subsForGroup = g.subs.length ? g.subs : submissions;

      const groupInfo: any = {
        subs: subsForGroup,
        cardsPreviewStatus: null,
        cardsPreviewRows: null,
        saveStatus: null,
        saveBodyItems: null,
        saveError: null,
      };

      // fetch cards
      const qs = new URLSearchParams({ subs: subsForGroup.join(',') }).toString();
      const cr = await fetch(`${base}/api/admin/billing/cards-preview?${qs}`, {
        headers: baseHeaders
      });
      groupInfo.cardsPreviewStatus = cr.status;

      if (!cr.ok) {
        debug.groupDebug.push(groupInfo);
        continue;
      }

      const cj = await cr.json().catch(() => ({}));
      const rows = Array.isArray(cj?.rows) ? cj.rows as CardsPreviewRow[] : [];
      groupInfo.cardsPreviewRows = rows.length;

      const items = rows
        .map(r => {
          const id = String((r.card_id ?? r.id) || '');
          return id ? { card_id: id, upcharge_cents: 0 } : null;
        })
        .filter(Boolean) as { card_id: string; upcharge_cents: number }[];

      groupInfo.saveBodyItems = items.length;
      if (items.length === 0) {
        debug.groupDebug.push(groupInfo);
        continue;
      }

      // ⭐ FORCE NEW INVOICE + GROUP CODE OVERRIDE
      const syntheticCode = `${originalGroupCode}-${groups.indexOf(g) + 1}`;
      const saveBody: any = {
        customer_email: customerEmail,
        items,
        invoice_id: null,
        force_new: true,
        group_code_override: syntheticCode
      };
      if (g.addr) saveBody.ship_to = g.addr;

      const sr = await fetch(`${base}/api/admin/billing/preview/save`, {
        method: 'POST',
        headers: { ...baseHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(saveBody),
      });

      groupInfo.saveStatus = sr.status;

      if (!sr.ok) {
        const t = await sr.text().catch(() => '');
        groupInfo.saveError = t.slice(0, 400);
        debug.groupDebug.push(groupInfo);
        continue;
      }

      const sj = await sr.json().catch(() => ({}));
      if (sj?.invoice_id) {
        created.push({ invoice_id: sj.invoice_id, subs: subsForGroup });
      } else {
        groupInfo.saveError = 'No invoice_id in response';
      }

      debug.groupDebug.push(groupInfo);
    }

    return res.status(200).json({ ok:true, created, debug });

  } catch (err: any) {
    console.error('[split-by-address] error', err);
    return res.status(500).json({ ok:false, error:'Server error', detail: err?.message });
  }
}
