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

// POST logout; ignore result
export async function logout() {
  try {
    await fetch('/api/admin-logout', {
      method: 'POST',
      credentials: 'same-origin'
    });
  } catch {}
}

// Fetch a FULL submission record suitable for the details sheet (includes shipping)
export async function fetchSubmissionDetails(id) {
  const urls = [
    `/api/admin/submission?id=${encodeURIComponent(id)}&full=1`,      // admin details (preferred)
    `/api/admin/submissions/${encodeURIComponent(id)}`,               // REST-style admin details
    `/api/submissions/${encodeURIComponent(id)}`,                     // non-admin details (legacy)
    `/api/submission?id=${encodeURIComponent(id)}`                    // non-admin query (legacy)
  ];

  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) continue;

      // normalize common shapes
      const item = j.item ?? j.submission ?? j.data ?? (j.ok === true ? j : null);
      if (item && typeof item === 'object') return item;
    } catch (e) { lastErr = e; }
  }
  throw new Error(lastErr?.message || 'Failed to load submission details');
}
