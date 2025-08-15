// /admin/js/api.js

export async function login(pass) {
  try {
    const res = await fetch('/api/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ pass }) // server expects { pass }
    });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok && j.ok === true, error: j.error };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export async function logout() {
  try {
    await fetch('/api/admin-logout', {
      method: 'POST',
      credentials: 'same-origin'
    });
  } catch {}
}

export async function fetchSubmissions(q) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  const url = `/api/admin/submissions${params.toString() ? `?${params}` : ''}`;

  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error || 'Failed to load');
  return Array.isArray(j.items) ? j.items : [];
}
