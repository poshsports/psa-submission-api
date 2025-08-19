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

  if (!res.ok || j?.ok !== true) {
    throw new Error(j?.error || 'Failed to load');
  }

  const items = Array.isArray(j.items) ? j.items : [];
  // handy for debugging
  window.__lastAdminFetch = j; // { ok, items, page, total, ... }
  return items;
}

// Fetch a single submission by id (server expects the plural endpoint with ?id=)
export async function fetchSubmission(id) {
  const idStr = String(id || '').trim();
  if (!idStr) throw new Error('Missing submission id');

  const url = `/api/admin/submissions?id=${encodeURIComponent(idStr)}`;

  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  const j = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(j?.error || 'Failed to load submission');
  }

  // Common shape today: { ok:true, items:[...] }
  if (Array.isArray(j.items)) {
    const needle = idStr.toLowerCase();
    const item =
      j.items.find(it => (it.submission_id || it.id || '').toLowerCase() === needle) ||
      j.items[0];
    if (!item) throw new Error('Submission not found');
    window.__lastAdminDetail = item;
    return item;
  }

  // Fallbacks if backend changes
  const item = j.item || j.data || j.submission || j;
  if (!item) throw new Error('Submission not found');
  window.__lastAdminDetail = item;
  return item;
}

// Optional: clearer alias for callers that want the "detail" name
export const fetchSubmissionDetail = fetchSubmission;

// POST logout; ignore result
export async function logout() {
  try {
    await fetch('/api/admin-logout', {
      method: 'POST',
      credentials: 'same-origin'
    });
  } catch {}
}
