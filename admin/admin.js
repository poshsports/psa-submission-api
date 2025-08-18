// ===== Helpers & State =====
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hide');
const hide = (id) => $(id).classList.add('hide');
const hasCookie = (name) => document.cookie.split(';').some(v => v.trim().startsWith(name + '='));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

let allRows = [];
let viewRows = [];
let sortKey = 'created_at';
let sortDir = 'desc'; // 'asc' | 'desc'
let currentView = 'Default';

// Column registry (add new columns here later; UI auto-updates)
const COLUMNS = [
  { key:'created_at',          label:'Created',          sortable:true,  align:'center',  format: fmtDate },
  { key:'submission_id',       label:'Submission',       sortable:true,  align:'center',  format: fmtCode },
  { key:'customer_email',      label:'Email',            sortable:true,  align:'center' },
  { key:'status',              label:'Status',           sortable:true,  align:'center' },
  { key:'cards',               label:'Cards',            sortable:true,  align:'right', format: fmtNum },
  { key:'evaluation',          label:'Evaluation',       sortable:true,  align:'center'  }, // Yes/No
  { key:'grand',               label:'Grand',            sortable:true,  align:'right', format: fmtMoney },
  { key:'grading_service',     label:'Grading Service',  sortable:true,  align:'center' },
  { key:'paid_at_iso',         label:'Paid',             sortable:true,  align:'center',  format: fmtDate },
  { key:'paid_amount',         label:'Paid $',           sortable:true,  align:'right', format: fmtMoney },
  { key:'shopify_order_name',  label:'Order',            sortable:true,  align:'center',  format: fmtCode }
];

// Default order/visibility derived from the registry
const defaultOrder = COLUMNS.map(c => c.key);
const defaultHidden = []; // all visible by default

// Local storage for views
const LS_KEY = 'psa_admin_table_views_v1';

// ===== Boot =====
document.addEventListener('DOMContentLoaded', () => {
  const authed = hasCookie('psa_admin');
$('auth-note').textContent = authed ? 'passcode session' : 'not signed in';
if (authed) {
  show('shell');
  hide('login');
  loadReal();           // auto-load after sign-in
} else {
  show('login');
  hide('shell');
}

  // Auth
  $('btnLogin')?.addEventListener('click', doLogin);
  $('pass')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('btnLogout').addEventListener('click', async () => {
    try { await fetch('/api/admin-logout', { method:'POST', cache:'no-store', credentials:'same-origin' }); } catch {}
    window.location.replace('/admin');
  });

  // Data load, search
  $('btnRefresh').addEventListener('click', loadReal);
  $('q').addEventListener('input', debounce(loadReal, 250)); // ask server to filter

  // Sorting: handled on dynamic header render

  // Views & customize
  initViews();
  const modalEl = $('modal');

  $('btnCustomize')?.addEventListener('click', openCustomize);
  $('btnCloseModal')?.addEventListener('click', closeCustomize);
  $('btnSave')?.addEventListener('click', saveView);
  $('btnSaveAs')?.addEventListener('click', saveAsView);
  $('btnDelete')?.addEventListener('click', deleteView);
  $('btnResetView')?.addEventListener('click', resetToDefault);

  // Extra modal UX: close on ESC and on backdrop click
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalEl && !modalEl.classList.contains('hide')) {
      closeCustomize();
    }
  });
  modalEl?.addEventListener('click', (e) => {
    // Only close if the click is on the dim backdrop, not inside the panel
    if (e.target === modalEl) closeCustomize();
  });
});


// ===== Auth =====
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

// ===== Views (local) =====
function readViews(){
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
  catch { return {}; }
}
function writeViews(v){ localStorage.setItem(LS_KEY, JSON.stringify(v)); }

function initViews(){
  const all = readViews();
  if (!all['Default']) {
    all['Default'] = { order: defaultOrder, hidden: defaultHidden, sortKey, sortDir };
    writeViews(all);
  }
  currentView = Object.keys(all)[0] || 'Default';
  renderViewSelect();
  applyView(currentView);
}

function renderViewSelect(){
  const all = readViews();
  const sel = $('viewSelect');
  sel.innerHTML = Object.keys(all).map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  sel.value = currentView;
  sel.onchange = () => { currentView = sel.value; applyView(currentView); };
}

function applyView(name){
  const all = readViews();
  const v = all[name] || all['Default'];
  if (!v) return;

  // Merge with current columns to handle new/removed columns gracefully
  const knownKeys = new Set(COLUMNS.map(c => c.key));
  let order = (v.order || defaultOrder).filter(k => knownKeys.has(k));
  // Add any brand-new columns (not in saved order) at the end, hidden by default
  const missing = COLUMNS.map(c => c.key).filter(k => !order.includes(k));
  order = order.concat(missing);

  const hidden = (v.hidden || defaultHidden).filter(k => knownKeys.has(k));

  sortKey = v.sortKey || 'created_at';
  sortDir = v.sortDir || 'desc';

  // Paint UI
  renderHead(order, hidden);
  applyFilters();
  $('viewName').value = name === 'Default' ? '' : name;
}

function saveView() {
  // You cannot overwrite the Default view
  if (currentView === 'Default') {
    alert('You can’t overwrite the Default view.\nUse “Save As” to create a new view.');
    $('viewName').focus();
    return;
  }

  // Ask to overwrite or branch to Save As
  const ok = confirm(`Overwrite the view “${currentView}” with the current settings?`);
  if (ok) {
    saveViewWithName(currentView);
    closeCustomize();
  } else {
    // Save As flow via prompt
    let name = prompt('Save as new view. Enter a name:', `${currentView} (copy)`);
    if (!name) return;
    name = name.trim();
    if (!name) { alert('View name is required.'); return; }
    if (name === 'Default') { alert('The name “Default” is reserved. Choose another.'); return; }

    const all = readViews();
    if (all[name]) {
      const ok2 = confirm(`A view named “${name}” already exists. Overwrite it?`);
      if (!ok2) return;
    }
    saveViewWithName(name);
    currentView = name;
    renderViewSelect();
    closeCustomize();
  }
}

function saveAsView() {
  let name = ($('viewName').value || '').trim();
  if (!name) {
    name = prompt('Enter a name for the new view:') || '';
    name = name.trim();
  }
  if (!name) { alert('View name is required.'); return; }
  if (name === 'Default') { alert('The name “Default” is reserved. Choose another.'); return; }

  const all = readViews();
  if (all[name]) {
    const ok = confirm(`A view named “${name}” already exists. Overwrite it?`);
    if (!ok) return;
  }

  saveViewWithName(name);
  currentView = name;
  renderViewSelect();
  closeCustomize();
}

// Helper to persist the current header/order/hidden/sort into a named view
function saveViewWithName(name) {
  const all = readViews();
  all[name] = currentHeaderState(); // { order, hidden, sortKey, sortDir }
  writeViews(all);
  applyView(name);
}

function deleteView(){
  if (currentView === 'Default') { alert('Cannot delete Default view.'); return; }
  const all = readViews();
  delete all[currentView];
  writeViews(all);
  currentView = 'Default';
  renderViewSelect();
  applyView(currentView);
  closeCustomize();
}

function resetToDefault(){
  const all = readViews();
  all[currentView] = { order: defaultOrder, hidden: defaultHidden, sortKey:'created_at', sortDir:'desc' };
  writeViews(all);
  applyView(currentView);
}

function currentHeaderState(){
  const { order, hidden } = getHeaderOrderAndHidden();
  return { order, hidden, sortKey, sortDir };
}

// ===== Customize Modal =====
function openCustomize(){
  // Build checkboxes from current columns and state
  const { order, hidden } = getHeaderOrderAndHidden();
  const setHidden = new Set(hidden);

  const html = order.map(key => {
    const col = COLUMNS.find(c => c.key === key);
    if (!col) return '';
    const checked = setHidden.has(key) ? '' : 'checked';
    return `
      <label><input type="checkbox" data-col="${key}" ${checked}/> ${escapeHtml(col.label)}</label>
    `;
  }).join('');
  $('colsList').innerHTML = html;

  // Wire checkbox changes
  $('colsList').querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      // Just update header state immediately
      const { order, hidden } = getHeaderOrderAndHidden();
      const hset = new Set(hidden);
      if (cb.checked) hset.delete(cb.dataset.col); else hset.add(cb.dataset.col);
      renderHead(order, Array.from(hset));
      applyFilters();
    });
  });

  show('modal');
}
function closeCustomize(){ hide('modal'); }

// ===== Header / Drag & Drop =====
function getHeaderOrderAndHidden(){
  const ths = Array.from(document.querySelectorAll('#subsHead th[data-key]'));
  const order = ths.map(th => th.dataset.key);
  const hidden = ths.filter(th => th.dataset.hidden === '1').map(th => th.dataset.key);
  return { order, hidden };
}

function renderHead(order, hidden){
  const hiddenSet = new Set(hidden || []);
  const head = $('subsHead');

  head.innerHTML = `
    <tr>
      ${order.map(key => {
        const col = COLUMNS.find(c => c.key === key);
        if (!col) return '';
        const caretId = 'car-' + key;
        const hiddenAttr = hiddenSet.has(key) ? ' data-hidden="1" style="display:none"' : '';
        return `
          <th class="${col.sortable ? 'sortable' : ''}" draggable="true" data-key="${key}"${hiddenAttr}>
            <span class="th-label">${escapeHtml(col.label)}</span>
            ${col.sortable ? `<span class="caret" id="${caretId}"></span>` : ''}
          </th>
        `;
      }).join('')}
    </tr>
  `;

  // Sorting click handlers
  head.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', (e) => {
      // avoid starting a drag counting as click
      if (e.target && e.target.tagName === 'INPUT') return;
      const key = th.dataset.key;
      if (sortKey === key) sortDir = (sortDir === 'asc') ? 'desc' : 'asc';
      else { sortKey = key; sortDir = 'desc'; }
      applyFilters();
      paintCarets();
    });
  });

  // Drag & drop to reorder
  let dragKey = null;
  head.querySelectorAll('th[draggable="true"]').forEach(th => {
    th.addEventListener('dragstart', (e) => { dragKey = th.dataset.key; e.dataTransfer.setData('text/plain', dragKey); });
    th.addEventListener('dragover', (e) => e.preventDefault());
    th.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetKey = th.dataset.key;
      if (!dragKey || dragKey === targetKey) return;

      const newOrder = Array.from(head.querySelectorAll('th[data-key]')).map(x => x.dataset.key);
      const from = newOrder.indexOf(dragKey);
      const to = newOrder.indexOf(targetKey);
      newOrder.splice(to, 0, newOrder.splice(from, 1)[0]);
      renderHead(newOrder, hidden);
      applyFilters();
    });
  });

  // Paint caret on active sort column
  paintCarets();
}

function paintCarets(){
  // Clear all
  document.querySelectorAll('#subsHead .caret').forEach(el => el.textContent = '');
  // Set active
  const el = document.getElementById('car-' + sortKey);
  if (el) el.textContent = sortDir === 'asc' ? '↑' : '↓';
}

// ===== Data normalize / render =====
function normalizeRow(r){
  const evalAmtNum = Number(
    (r.evaluation ?? 0) ||
    (r.eval_line_sub ?? 0) ||
    (r?.totals?.evaluation ?? 0)
  ) || 0;
  const evalBool = evalAmtNum > 0;

  return {
    submission_id: r.submission_id || r.id || '',
    customer_email: r.customer_email || r.customer_em || r.email || '',
    cards: Number(r.cards ?? (Array.isArray(r.card_info) ? r.card_info.length : 0)) || 0,
    evaluation_bool: evalBool,
    evaluation: evalBool ? 'Yes' : 'No',
    grand: Number(r?.totals?.grand ?? r.grand_total ?? r.total ?? 0) || 0,
    status: r.status || '',
    grading_service: String(r.grading_service ?? r.grading_services ?? r.grading_servi ?? r.service ?? r.grading ?? '').trim(),
    created_at: r.created_at || r.inserted_at || r.submitted_at_iso || '',

    // NEW fields coming from /api/admin/submissions
    paid_at_iso: r.paid_at_iso || '',
    paid_amount: Number(r.paid_amount || 0) || 0,
    shopify_order_name: r.shopify_order_name || ''
  };
}

function applyFilters(){
  const q = $('q').value.trim().toLowerCase();

  // Determine current visible columns from header
  const ths = Array.from(document.querySelectorAll('#subsHead th[data-key]')).filter(th => th.style.display !== 'none');
  const visibleKeys = ths.map(th => th.dataset.key);

  // Filter (email or submission id)
  viewRows = allRows.filter(r => {
    if (!q) return true;
    return (r.customer_email && r.customer_email.toLowerCase().includes(q))
        || (r.submission_id && r.submission_id.toLowerCase().includes(q));
  });

  // Sort
  const dir = sortDir === 'asc' ? 1 : -1;
  viewRows.sort((a, b) => {
    // booleans
    if (sortKey === 'evaluation') {
      return ((a.evaluation_bool ? 1 : 0) - (b.evaluation_bool ? 1 : 0)) * dir;
    }
    // numbers
    if (sortKey === 'cards' || sortKey === 'grand') {
      return (Number(a[sortKey]) - Number(b[sortKey])) * dir;
    }
    // dates
    if (sortKey === 'created_at') {
      const na = new Date(a.created_at).getTime();
      const nb = new Date(b.created_at).getTime();
      if (!isNaN(na) && !isNaN(nb)) return (na - nb) * dir;
    }
    // strings
    return String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? '')) * dir;
  });

  renderTable(viewRows, visibleKeys);
  $('countPill').textContent = String(viewRows.length);

  // Persist sort into the view
  const all = readViews();
  const v = all[currentView] || {};
  v.sortKey = sortKey; v.sortDir = sortDir;
  // Also persist order/hidden (from header)
  const state = currentHeaderState();
  v.order = state.order; v.hidden = state.hidden;
  all[currentView] = v;
  writeViews(all);
}

function renderTable(rows, visibleKeys){
  const body = $('subsTbody');
  if (!rows.length) { hide('subsWrap'); show('subsEmpty'); body.innerHTML = ''; return; }
  hide('subsEmpty'); show('subsWrap');

  const colMap = new Map(COLUMNS.map(c => [c.key, c]));
  const alignClass = (key) => (colMap.get(key)?.align === 'right' ? 'right' : '');

  body.innerHTML = rows.map(r => `
    <tr>
      ${visibleKeys.map(key => {
        const col = colMap.get(key);
        const val = r[key];
        const out = col?.format ? col.format(val) : escapeHtml(String(val ?? ''));
        return `<td class="${alignClass(key)}">${out}</td>`;
      }).join('')}
    </tr>
  `).join('');
}

// ===== Data fetch =====
async function loadReal(){
  const err = $('subsErr'); err.classList.add('hide'); err.textContent = '';
  try {
    const q = ($('q')?.value || '').trim();
    // If you later add a <select id="status"> in the UI, this will automatically work:
    const status = ($('status')?.value || '').trim();

    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);

    const url = params.toString()
      ? `/api/admin/submissions?${params.toString()}`
      : `/api/admin/submissions`;

    const res = await fetch(url, { cache:'no-store', credentials:'same-origin' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) throw new Error(j.error || 'Failed to load');
    allRows = Array.isArray(j.items) ? j.items.map(normalizeRow) : [];
    applyFilters();
  } catch (e) {
    err.textContent = e.message || 'Load failed';
    err.classList.remove('hide');
  }
}

// ===== Formatting helpers =====
function fmtDate(iso){ try { if (!iso) return ''; const d = new Date(iso); if (isNaN(d.getTime())) return ''; return d.toLocaleString(); } catch { return ''; } }
function fmtMoney(n){ return `$${(Number(n)||0).toLocaleString()}`; }
function fmtNum(n){ return `${Number(n)||0}`; }
function fmtCode(s){ const str = String(s ?? ''); return str ? `<code>${escapeHtml(str)}</code>` : ''; }
function escapeHtml(s){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
