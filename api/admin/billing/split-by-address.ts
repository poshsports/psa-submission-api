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

  // Already normalized?
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
    subs?: string[]; // legacy
  };

  // --- Normalize submissions ---
  let submissions: string[] | undefined = body.submissions;
  if (!Array.isArray(submissions) || submissions.length === 0) {
    if (Array.isArray(body.subs) && body.subs.length > 0) {
      submissions = body.subs;
    }
  }

  if (!Array.isArray(submissions) || submissions.length === 0) {
    return res.status(400).json({ ok: false, error: 'Missing submissions/subs[]' });
  }

  // --- Normalize customer email ---
  let customerEmail: string | undefined =
    (typeof body.customer_email === 'string' && body.customer_email.trim()) ||
    (typeof body.email === 'string' && body.email.trim()) ||
    undefined;

  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const host  = (req.headers['x-forwarded-host'] as string) || (req.headers.host as string);
  const base  = `${proto}://${host}`;

  const debug: any = {
    submissions,
    addressGroupsReceived: Array.isArray(body.addressGroups) ? body.addressGroups.length : 0,
    groupDebug: [] as any[],
  };

  try {
    // If no email provided, derive from first submission
    if (!customerEmail) {
      const firstId = submissions[0];
      const sr = await fetch(
        `${base}/api/admin/submission?id=${encodeURIComponent(firstId)}&full=1`,
        { headers: { accept: 'application/json' } }
      );
      if (sr.ok) {
        const sj = (await sr.json()) as SubmissionResp;
        const fromSub =
          sj?.item?.customer_email ||
          sj?.item?.email ||
          undefined;
        if (fromSub) customerEmail = fromSub;
      }

      if (!customerEmail) {
        return res.status(400).json({ ok: false, error: 'Missing customer email', debug });
      }
    }

    // --- Build groups ---
    let groups: { addr: ReturnType<typeof normAddr> | null; subs: string[] }[] = [];

    if (Array.isArray(body.addressGroups) && body.addressGroups.length > 0) {
      groups = body.addressGroups
        .map((g) => ({
          addr: normAddr(g.addr ?? null),
          subs: Array.isArray(g.subs) ? g.subs.filter(Boolean) : [],
        }))
        .filter((g) => g.subs.length > 0);
    } else {
      const map = new Map<string, { addr: ReturnType<typeof normAddr>; subs: string[] }>();

      for (const id of submissions) {
        const r = await fetch(
          `${base}/api/admin/submission?id=${encodeURIComponent(id)}&full=1`,
          { headers: { accept: 'application/json' } }
        );
        if (!r.ok) continue;
        const j = (await r.json()) as SubmissionResp;
        const addr = normAddr(j?.item?.shipping_address ?? null);
        const key  = addrKey(addr);
        if (!map.has(key)) {
          map.set(key, { addr, subs: [] });
        }
        map.get(key)!.subs.push(id);
      }

      groups = [...map.values()];
    }

    if (groups.length === 0) {
      groups = [{ addr: null, subs: submissions }];
    }

    debug.groupCount = groups.length;

    const created: { invoice_id: string; subs: string[] }[] = [];

    for (const g of groups) {
      const subsForGroup = g.subs.length ? g.subs : submissions;

      const groupInfo: any = {
        subs: subsForGroup,
        cardsPreviewStatus: null as null | number,
        cardsPreviewRows: null as null | number,
        saveStatus: null as null | number,
        saveBodyItems: null as null | number,
        saveError: null as null | string,
      };

      // --- cards-preview for this group ---
      const qs = new URLSearchParams({ subs: subsForGroup.join(',') }).toString();
      const cr = await fetch(`${base}/api/admin/billing/cards-preview?${qs}`, {
        headers: { accept: 'application/json' },
      });

      groupInfo.cardsPreviewStatus = cr.status;

      if (!cr.ok) {
        debug.groupDebug.push(groupInfo);
        continue;
      }

      const cj = await cr.json().catch(() => ({} as { rows?: CardsPreviewRow[] }));
      const rows = Array.isArray((cj as any)?.rows) ? ((cj as any).rows as CardsPreviewRow[]) : [];

      groupInfo.cardsPreviewRows = rows.length;

      const items = rows
        .map((r) => {
          const id = String((r.card_id ?? r.id) || '');
          return id ? { card_id: id, upcharge_cents: 0 } : null;
        })
        .filter(Boolean) as { card_id: string; upcharge_cents: number }[];

      groupInfo.saveBodyItems = items.length;

      if (items.length === 0) {
        debug.groupDebug.push(groupInfo);
        continue;
      }

      const saveBody: any = { customer_email: customerEmail, items };
      if (g.addr) saveBody.ship_to = g.addr;

      const sr = await fetch(`${base}/api/admin/billing/preview/save`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(saveBody),
      });

      groupInfo.saveStatus = sr.status;

      if (!sr.ok) {
        const txt = await sr.text().catch(() => '');
        groupInfo.saveError = txt.slice(0, 400);
        debug.groupDebug.push(groupInfo);
        continue;
      }

      const sj = await sr.json().catch(() => ({} as { invoice_id?: string }));
      if (sj?.invoice_id) {
        created.push({ invoice_id: sj.invoice_id, subs: subsForGroup });
      } else {
        groupInfo.saveError = 'No invoice_id in response';
        debug.groupDebug.push(groupInfo);
      }
    }

    return res.status(200).json({ ok: true, created, debug });
  } catch (err: any) {
    console.error('[split-by-address] error', err);
    return res.status(500).json({ ok: false, error: 'Server error', detail: err?.message ?? String(err) });
  }
}
