// ----- helpers -----
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hide');
const hide = (id) => $(id).classList.add('hide');
const hasCookie = (name) => document.cookie.split(';').some(v => v.trim().startsWith(name + '='));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

let allRows = [];
let viewRows = [];
let sortKey = 'created_at';
let sortDir = 'desc'; // 'asc' | 'desc'

function paintCarets() {
  const ids = {
    created_at: 'carCreated',
    friendly_id: 'carFriendly',
    submission_id: 'carSubmission',
    customer_email: 'carEmail',
    status: 'carStatus',
    cards: 'carCards',
    grand: 'carGrand',
    last_updated_at: 'carUpdated'
  };
  Object.values(ids).forEach(id => { const el = $(id); if (el) el.textContent = ''; });
  const active = $(ids[sortKey]);
  if (active) active.textContent = sortDir === 'asc' ? '↑' : '↓';
}

function normalizeRow(r){
  return {
    submission_id: r.submission_id || r.id || '',
    // Friendly ID stays empty for now; we’ll wire the real field next step
    friendly_id: r.friendly_id || r.friendly || r.short_id || r.display_id || r.friendly_submission_id || r.submission_friendly_id || '',
    customer_email: r.customer_email || r.email || '',
    cards: Number(r.cards ?? (Array.isArray(r.card_info) ? r.card_info.length : 0)) || 0,
    grand: Number(r?.totals?.grand ?? r.grand_total ?? r.total ?? 0) || 0,
    status: r.status || '',
    created_at: r.created_at || r.inserted_at || r.submitted_at_iso || '',
    last_updated_at: r.last_updated_at || r.updated_at || r.updated_at_iso || ''
  };
}

function applyFilters(){
  const q = $('q').value.trim().toLowerCase();

  viewRows = allRows.filter(r => {
    if (!q) return true;
    return (r.customer_email && r.customer_email.toLowerCase().includes(q))
        || (r.submission_id && r.submission_id.toLowerCase().includes(q))
        || (r.friendly_id && r.friendly_id.toLowerCase().includes(q));
  });

  const dir = sortDir === 'asc' ? 1 : -1;
  viewRows.sort((a, b) => {
    const ka = (sortKey === 'grand') ? a.grand : a[sortKey];
    const kb = (sortKey === 'grand') ? b.grand : b[sortKey];
    if (ka == null && kb == null) return 0;
    if (ka == null) return 1;
    if (kb == null) return -1;
    if (sortKey === 'cards' || sortKey === 'grand') {
      return (Number(ka) - Number(kb)) * dir;
    }
    const na = new Date(ka).getTime();
    const nb = new Date(kb).getTime();
    if (!isNaN(na) && !isNaN(nb)) return (na - nb) * dir;
    return String(ka).localeCompare(String(kb)) * dir;
  });

  renderTable(viewRows);
  $('countPill').textContent = String(viewRows.length);
}

function renderTable(rows){
  const wrap = $('subsWrap'), empty = $('subsEmpty'), body = $('subsTbody');
  if (!rows.length) {
    hide('subsWrap'); show('subsEmpty'); body.innerHTML = '';
    return;
  }
  hide('subsEmpty'); show('subsWrap');

  body.innerHTML = rows.map(r => {
    const created = fmtDate(r.created_at);
    const updated = fmtDate(r.last_updated_at);
    return `
      <tr>
        <td>${created}</td>
        <td>${r.friendly_id ? `<code>${r.friendly_id}</code>` : ''}</td>
        <td><code>${r.submission_id || ''}</code></td>
        <td>${r.customer_email || ''}</td>
        <td>${r.status || ''}</td>
        <td align="right">${r.cards ?? ''}</td>
        <td align="right">$${Number(r.grand).toLocaleString()}</td>
        <td>${updated}</td>
      </tr>
    `;
  }).join('');
}

function fmtDate(iso){
  try {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString();
  } catch { return ''; }
}

// ----- events / bootstrap -----
document.addEventListener('DOMContentLoaded', () => {
  // auth shell
  $('auth-note').textContent = hasCookie('psa_admin') ? 'passcode session' : 'not signed in';
  if (hasCookie('psa_admin')) { show('shell'); hide('login'); } else { show('login'); hide('shell'); }

  // login
  $('btnLogin')?.addEventListener('click', doLogin);
  $('pass')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  async function doLogin(){
    const pass = $('pass').value.trim();
    $('err').textContent = '';
    try {
      const res = await fetch('/api/admin-login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ pass }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error === 'invalid_pass' ? 'Invalid passcode' : 'Login failed');
      location.replace('/admin');
    } catch (e) { $('err').textContent = e.message || 'Login failed'; }
  }

  // logout
  $('btnLogout').addEventListener('click', async () => {
    try { await fetch('/api/admin-logout', { method:'POST', cache:'no-store', credentials:'same-origin' }); } catch {}
    window.location.replace('/admin');
  });

  // sort header clicks
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (sortKey === key) sortDir = (sortDir === 'asc') ? 'desc' : 'asc';
      else { sortKey = key; sortDir = 'desc'; }
      applyFilters();
      paintCarets();
    });
  });
  paintCarets();

  // search
  $('q').addEventListener('input', debounce(applyFilters, 200));

  // load real
  $('btnLoadReal').addEventListener('click', loadReal);
});

async function loadReal(){
  const err = $('subsErr'); err.classList.add('hide'); err.textContent = '';
  try {
    const res = await fetch('/api/admin/submissions', { cache:'no-store', credentials:'same-origin' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) throw new Error(j.error || 'Failed to load');
    allRows = Array.isArray(j.items) ? j.items.map(normalizeRow) : [];
    applyFilters();
  } catch (e) {
    err.textContent = e.message || 'Load failed';
    err.classList.remove('hide');
  }
}
