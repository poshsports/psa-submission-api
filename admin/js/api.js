// /admin/js/api.js

// Fetch the admin submissions list and return the ARRAY of rows
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
  window.__lastAdminFetch = j; // debug hook
  return items;
}

// Try multiple endpoints to get the *full* submission object.
// 1) Start with the admin list (works today).
// 2) If that object lacks details (no card_info, address, …), try the user detail
//    endpoint(s) and merge.
export async function fetchSubmission(id) {
  const enc = encodeURIComponent(id);

  // helper to fetch+json safely
  async function getJSON(url) {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return null;
    try { return await res.json(); } catch { return null; }
  }

  // ---- 1) admin list endpoint (returns items: [...] ) ----
  let base = null;
  const listJson = await getJSON(`/api/admin/submissions?id=${enc}`);
  if (listJson && Array.isArray(listJson.items)) {
    base = listJson.items.find(
      it => (it.submission_id || it.id || '').toLowerCase() === String(id).toLowerCase()
    ) || listJson.items[0] || null;
  }

  // if we already have deep details, return
  const hasDetails = (obj) =>
    obj && (
      Array.isArray(obj.card_info) ||
      obj.card_info?.length ||
      obj.ship_addr1 || obj.address1 || obj.ship_to || obj.shipping
    );

  if (hasDetails(base)) return base;

  // ---- 2) try detail endpoints and merge ----
  // These mirror what the customer portal uses; admin cookie should still allow them.
  const candidates = [
    `/api/submission?id=${enc}`,
    `/api/submissions?id=${enc}` // fallback if your detail route pluralizes
  ];

  for (const u of candidates) {
    const j = await getJSON(u);
    if (!j) continue;

    const detail =
      j.item ||
      j.data ||
      j.submission ||
      (Array.isArray(j.items) ? j.items[0] : (typeof j === 'object' ? j : null));

    if (detail && typeof detail === 'object') {
      // merge with list base so we keep totals etc. whichever side provided them
      return { ...(base || {}), ...detail };
    }
  }

  if (base) return base;
  throw new Error('Failed to load submission');
}

// POST logout; ignore result
export async function logout() {
  try {
    await fetch('/api/admin-logout', { method: 'POST', credentials: 'same-origin' });
  } catch {}
}
