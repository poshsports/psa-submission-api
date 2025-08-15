export async function login(pass){
  const res = await fetch('/api/admin-login', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ pass })
  });
  const j = await res.json().catch(()=>({}));
  return { ok: res.ok && j.ok, error: j.error || (res.ok ? '' : 'Login failed') };
}

export async function logout(){
  try { await fetch('/api/admin-logout', { method:'POST', cache:'no-store', credentials:'same-origin' }); } catch {}
}

export async function fetchSubmissions(q, status){
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  const url = params.toString() ? `/api/admin/submissions?${params.toString()}` : `/api/admin/submissions`;

  const res = await fetch(url, { cache:'no-store', credentials:'same-origin' });
  const j = await res.json().catch(()=>({}));
  if (!res.ok || !j.ok) throw new Error(j.error || 'Failed to load');
  return Array.isArray(j.items) ? j.items : [];
}
