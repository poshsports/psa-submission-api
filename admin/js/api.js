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

  // Return just the array of items
  const items = Array.isArray(j.items) ? j.items : [];
  // (optional) quick debug hook when you need it:
  window.__lastAdminFetch = j; // contains { ok, items, page, total, ... }
  return items;
}

// POST logout; ignore result
export async function logout() {
  try {
    await fetch('/api/admin-logout', {
      method: 'POST',
      credentials: 'same-origin'
    });
  } catch {}
}
