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

// Carets for the current sort column
function paintCarets() {
  const ids = {
    created_at: 'carCreated',
    submission_id: 'carSubmission',
    customer_email: 'carEmail',
    status: 'carStatus',
    cards: 'carCards',
    evaluation: 'carEvaluation',
    grand: 'carGrand',
    grading_service: 'carService'
  };
  Object.values(ids).forEach(id => { const el = $(id); if (el) el.textContent = ''; });
  const active = $(ids[sortKey]);
  if (active) active.textContent = sortDir === 'asc' ? '↑' : '↓';
}

// Normalize a row from Supabase into what we render
function normalizeRow(r){
  // evaluation should be Yes/No for the table; compute truthy if any known field > 0
  const evalAmt = Number(
    (r.evaluation ?? 0) ||
    (r.eval_line_sub ?? 0) ||
    (r?.totals?.evaluation ?? 0)
  ) || 0;
  const evalBool = evalAmt > 0;

  return {
    submission_id: r.submission_id || r.id || '',
    customer_email: r.customer_email || r.customer_em || r.email || '',
    cards: Number(r.cards ?? (Array.isArray(r.card_info) ? r.card_info.length : 0)) || 0,
    evaluation_bool: evalBool,
    evaluation: evalBool ? 'Yes' : 'No',
    grand: Number(r?.totals?.grand ?? r.grand_total ?? r.total ?? 0) || 0,
    status: r.status || '',
    grading_service: r.grading_service || r.grading_servi || r.service || r.grading || '',
    created_at: r.created_at || r.inserted_at || r.submitted_at_iso || ''
  };
}

// Filter + sort, then render
function applyFilters(){
  const q = $('q').value.trim().toLowerCase();

  viewRows = allRows.filter(r => {
    if (!q) return true;
    return (r.customer_email && r.customer_email.toLowerCase().includes(q))
        || (r.submission_id && r.submission_id.toLowerCase().includes(q));
  });

  const dir = sortDir === 'asc' ? 1 : -1;
  viewRows.sort((a, b) => {
    // Special sort for evaluation (sort by boolean), and grand/cards as numbers
    if (sortKey === 'evaluation') {
      return ((a.evaluation_bool ? 1 : 0) - (b.evaluation_bool ? 1 : 0)) * dir;
    }
    if (sortKey === 'cards' || sortKey === 'grand') {
      return (Number(a[sortKey]) - Number(b[sortKey])) * dir;
    }

    const ka = a[sortKey];
    const kb = b[sortKey];

    // dates
    if (sortKey === 'created_at') {
      const na = new Date(ka).getTime();
      const nb = new Date(kb).getTime();
      if (!isNaN(na) && !isNaN(nb)) return (na - nb) * dir;
    }

    // strings
    return String(ka ?? '').localeCompare(String(kb ?? '')) * dir;
  });

  renderTable(viewRows);
  $('countPill').textContent = String(viewRows.length);
}

// Render table body
function renderTable(rows){
  const wrap = $('subsWrap'), empty = $('subsEmpty'), body = $('subsTbody');
  if (!rows.length) {
    hide('subsWrap'); show('subsEmpty'); body.innerHTML = '';
    return;
  }
  hide('subsEmpty'); show('subsWrap');

  body.innerHTML = rows.map(r => `
    <tr>
      <td>${fmtDate(r.created_at)}</td>
      <td><code>${r.submission_id || ''}</code></td>
      <td>${r.customer_email || ''}</td>
      <td>${r.status || ''}</td>
      <td align="right">${r.cards ?? ''}</td>
      <td>${r.evaluation}</td>
      <td align="right">$${Number(r.grand).toLocaleString()}</td>
      <td>${r.grading_service || ''}</td>
    </tr>
  `).join('');
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
  $('auth-note').textContent = hasCookie('psa_admin') ? 'passcode session' : 'not signed in';
  if (hasCookie('psa_admin')) { show('shell'); hide('login'); } else { show('login'); hide('shell'); }

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

  // search & load
  $('q').addEventListener('input', debounce(applyFilters, 200));
  $('btnLoadReal').addEventListener('click', loadReal);
});

// Fetch from our server-side API
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
