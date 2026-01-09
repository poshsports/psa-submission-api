// /api/admin/billing/split-by-address.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Utilities
 */
type ShipAddr = {
  name?: string;
  contact?: string;
  full_name?: string;
  first_last?: string;
  attn?: string;

  line1?: string;
  address1?: string;
  addr1?: string;
  street?: string;

  line2?: string;
  address2?: string;
  addr2?: string;

  city?: string;
  region?: string;
  state?: string;
  province?: string;

  postal?: string;
  zip?: string;
  postal_code?: string;
  postcode?: string;

  country?: string;
};

function normAddr(a?: ShipAddr | null) {
  if (!a) return null;
  const name = (a.name ??
    a.contact ??
    a.full_name ??
    a.first_last ??
    a.attn ??
    ""
  ).trim();
  const line1 = (a.line1 ?? a.address1 ?? a.addr1 ?? a.street ?? "").trim();
  const line2 = (a.line2 ?? a.address2 ?? a.addr2 ?? "").trim();
  const city = (a.city ?? "").trim();
  const region = (a.region ?? a.state ?? a.province ?? "").trim();
  const postal = (a.postal ??
    a.zip ??
    a.postal_code ??
    a.postcode ??
    ""
  ).trim();
  const country = (a.country ?? "US").trim();
  return { name, line1, line2, city, region, postal, country };
}

function addrKey(a: ReturnType<typeof normAddr>) {
  if (!a) return "∅";
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

/**
 * Resolve the original invoice containing these subs
 */
async function findParentInvoice(base: string, headers: any, sub: string) {
  const resp = await fetch(`${base}/api/admin/billing/find-invoice-by-sub`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ submission_id: sub }),
  });
  if (!resp.ok) return null;
  const j = await resp.json().catch(() => null);
  return j?.invoice_id ?? null;
}

/**
 * Update invoice status helper
 */
async function markInvoiceArchived(
  base: string,
  headers: any,
  invoiceId: string
) {
  return fetch(`${base}/api/admin/billing/update-invoice-status`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ invoice_id: invoiceId, status: "superseded" }),
  });
}

/**
 * Main handler
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const body = req.body || {};
  const submissions: string[] = body.submissions || body.subs || [];

  if (!Array.isArray(submissions) || submissions.length === 0) {
    return res.status(400).json({ ok: false, error: "Missing submissions[]" });
  }

  // Build base URL & headers
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host =
    (req.headers["x-forwarded-host"] as string) || (req.headers.host as string);
  const base = `${proto}://${host}`;

  const cookie = req.headers.cookie;
  const auth = req.headers.authorization;
  const xAdmin = req.headers["x-admin-token"];

  const baseHeaders: Record<string, string> = { accept: "application/json" };
  if (cookie) baseHeaders.cookie = cookie;
  if (auth) baseHeaders.authorization = auth;
  if (xAdmin) baseHeaders["x-admin-token"] = xAdmin;

  const debug: any = {
    submissions,
    groupsRaw: body.addressGroups,
    groupsProcessed: [],
    createdInvoices: [],
  };

  /**
   * 1) Build address groups
   */
  let groups: { addr: ReturnType<typeof normAddr> | null; subs: string[] }[] =
    [];

  if (Array.isArray(body.addressGroups) && body.addressGroups.length > 0) {
    groups = body.addressGroups
      .map((g: any) => ({
        addr: normAddr(g.addr ?? null),
        subs: Array.isArray(g.subs) ? g.subs.filter(Boolean) : [],
      }))
      .filter((g: any) => g.subs.length > 0);
  } else {
    // auto-group by actual submission shipping addresses
    const map = new Map<
      string,
      { addr: ReturnType<typeof normAddr>; subs: string[] }
    >();
    for (const id of submissions) {
      const r = await fetch(
        `${base}/api/admin/submission?id=${encodeURIComponent(id)}&full=1`,
        { headers: baseHeaders }
      );
      if (!r.ok) continue;
      const j = await r.json();
      const addr = normAddr(j?.item?.shipping_address ?? null);
      const key = addrKey(addr);
      if (!map.has(key)) map.set(key, { addr, subs: [] });
      map.get(key)!.subs.push(id);
    }
    groups = [...map.values()];
  }

  if (!groups.length) groups = [{ addr: null, subs: submissions }];
  debug.groupsProcessed = groups;

  /**
   * 2) Resolve parent invoice
   */
  const parentInvoiceId = await findParentInvoice(
    base,
    baseHeaders,
    submissions[0]
  );
  debug.parentInvoice = parentInvoiceId;

  /**
   * 3) Create all child invoices
   */
  const created: { invoice_id: string; subs: string[] }[] = [];

  for (const [index, group] of groups.entries()) {
    const subsForGroup = group.subs.length ? group.subs : submissions;

    // Fetch card rows
    const qs = new URLSearchParams({
      subs: subsForGroup.join(","),
    }).toString();
    const cr = await fetch(`${base}/api/admin/billing/cards-preview?${qs}`, {
      headers: baseHeaders,
    });
    const cj = cr.ok ? await cr.json().catch(() => ({})) : {};
    const rows = Array.isArray(cj.rows) ? cj.rows : [];

    const items = rows
      .map((r: any) => ({
        card_id: String(r.card_id ?? r.id ?? ""),
        upcharge_cents: 0,
      }))
      .filter((r: any) => !!r.card_id);

    if (!items.length) continue;

    // Construct synthetic split group code
    const synthetic = `${groups.length === 1 ? "GRP" : "GRP"}-SPLIT-${index + 1
      }-${Date.now()}`;

    const saveBody: any = {
      invoice_id: null,
      force_new: true,
      customer_email: body.customer_email,
      items,
      group_code_override: synthetic,
    };
    if (group.addr) saveBody.ship_to = group.addr;

    const s = await fetch(`${base}/api/admin/billing/preview/save`, {
      method: "POST",
      headers: { ...baseHeaders, "content-type": "application/json" },
      body: JSON.stringify(saveBody),
    });

    if (!s.ok) continue;
    const sj = await s.json().catch(() => null);

    if (sj?.invoice_id) {
      created.push({ invoice_id: sj.invoice_id, subs: subsForGroup });
    }
  }

  debug.createdInvoices = created;

  /**
   * 4) Archive the parent invoice
   */
  if (parentInvoiceId) {
    await markInvoiceArchived(base, baseHeaders, parentInvoiceId);
    debug.parentInvoiceArchived = true;
  } else {
    debug.parentInvoiceArchived = false;
  }

  return res.status(200).json({ ok: true, created, debug });
}
