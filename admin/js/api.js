// /admin/js/api.js

// ---- helpers ---------------------------------------------------------------
function hasAddress(o) {
  if (!o || typeof o !== 'object') return false;

  // direct single-field form
  if (typeof o.ship_to === 'string' && o.ship_to.trim()) return true;

  // common nested containers
  const nests = [
    o.shipping_address,
    o.shopify_shipping_address,
    o.ship_address,
    o.address,
    o.shipping,
    o.shippingAddress,
    o.customer?.shipping_address,
    o.customer?.default_address,
    o.order?.shipping_address,
    o.order?.shippingAddress
  ];
  for (const n of nests) {
    if (!n || typeof n !== 'object') continue;
    if (n.address1 || n.line1 || n.street || n.city || n.region || n.state || n.postal_code || n.zip) {
      return true;
    }
  }

  // last-resort sniff
  return Object.keys(o).some(k => /ship|address/i.test(k));
}

function pickItemFromResponse(j) {
  // normalize common shapes coming from different endpoints
  return j?.item ?? j?.submission ?? j?.data ?? null;
}

// ---- Submissions list ------------------------------------------------------
export async function fetchSubmissions(q = '') {
  const params = new URLSearchParams();
  if (q) params.set('q', q);

  const url = params.toString()
    ? `/api/admin/submissions?${params.toString()}`
    : `/api/admin/submissions`;

  const res = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin'
  });

  const j = await res.json().catch(() => ({}));

  if (!res.ok || j.ok !== true) {
    throw new Error(j.error || 'Failed to load');
  }

  const items = Array.isArray(j.items) ? j.items : [];
  // quick debug hook when you need it (does not log to console)
  window.__lastAdminFetch = j; // { ok, items, page, total, ... }
  return items;
}

// ---- Groups (create / add / read) -----------------------------------------
export async function createGroup({ code = null, status = 'Draft', notes = null } = {}) {
  const r = await fetch('/api/admin/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, status, notes })
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); msg = j.error || msg; } catch {}
    throw new Error(msg);
  }
  const j = await r.json();
  if (j?.ok !== true || !j.group?.code) throw new Error('Create group failed');
  return j.group; // { id, code, status, notes, created_at }
}

export async function addToGroup(groupIdOrCode, submissionIds) {
  const r = await fetch(`/api/admin/groups/${encodeURIComponent(groupIdOrCode)}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ submission_ids: submissionIds })
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); msg = j.error || msg; } catch {}
    throw new Error(msg);
  }
  return r.json(); // { ok, added_submissions, added_cards }
}

// --- Groups (read-only) ---
export async function fetchGroups({ status=null, q=null, limit=50, offset=0 } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (q) params.set('q', q);
  params.set('limit', String(limit));
  params.set('offset', String(offset));

  const r = await fetch(`/api/admin/groups?${params.toString()}`, {
    credentials: 'same-origin'
  });

  if (!r.ok) throw new Error(`Groups list failed: ${r.status}`);
  return r.json();
}

export async function fetchGroup(id) {
  const r = await fetch(`/api/admin/groups/${encodeURIComponent(id)}`, {
    credentials: 'same-origin'
  });

  if (r.status === 404) return { ok: false, notFound: true };
  if (!r.ok) throw new Error(`Get group failed: ${r.status}`);
  return r.json();
}

// ---- Single submission (summary) -------------------------------------------
export async function fetchSubmission(id) {
  const url = `/api/admin/submission?id=${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store'
  });

  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok !== true) throw new Error(j.error || 'Failed to load submission');
  return j.item;
}

// ---- Single submission (details with shipping) -----------------------------
export async function fetchSubmissionDetails(id) {
  const urls = [
    `/api/admin/submission?id=${encodeURIComponent(id)}&full=1`, // preferred: full admin payload
    `/api/admin/submissions/${encodeURIComponent(id)}`,          // REST-style admin
    `/api/submissions/${encodeURIComponent(id)}`,                // legacy non-admin
    `/api/submission?id=${encodeURIComponent(id)}`               // legacy query
  ];

  let lastSeen = null;
  let lastErr;

  for (const url of urls) {
    try {
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) continue;

      const item = pickItemFromResponse(j);
      if (item && typeof item === 'object') {
        try { Object.defineProperty(item, '__details_source', { value: url, enumerable: false }); } catch {}
        if (hasAddress(item)) return item; // only accept when we see address fields
        if (!lastSeen) lastSeen = item;    // keep a valid fallback
      }
    } catch (e) {
      lastErr = e;
    }
  }

  if (lastSeen) return lastSeen;
  throw new Error(lastErr?.message || 'Failed to load submission details');
}

// ---- POST logout; ignore result --------------------------------------------
export async function logout() {
  try {
    await fetch('/api/admin-logout', {
      method: 'POST',
      credentials: 'same-origin'
    });
  } catch {}
}
