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

export async function fetchSubmission(id) {
  // This is the only shape your backend returns 200 for (confirmed in console).
  const url = `/api/admin/submissions?id=${encodeURIComponent(id)}`;

  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load submission`);

  const j = await res.json().catch(() => ({}));

  // Unwrap common shapes
  if (Array.isArray(j.items)) {
    const item = j.items.find(
      it => (it.submission_id || it.id || '').toLowerCase() === String(id).toLowerCase()
    ) || j.items[0];
    if (!item) throw new Error('Submission not found');
    return item;
  }

  // Fallbacks if backend ever changes
  if (j.item) return j.item;
  if (j.data) return j.data;
  if (j.submission) return j.submission;

  return j; // assume the object itself
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
