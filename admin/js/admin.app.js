import { $, debounce } from './util.js';
import { fetchSubmissions, logout } from './api.js';
import * as tbl from './table.js';
import * as views from './views.js';

window.__tbl = tbl; // DevTools helper

async function doLogout(e){
  e?.preventDefault?.();
  try { await logout(); } catch {}
  window.location.replace('/admin'); // leave page even if POST fails
}
window.__doLogout = doLogout;

function wireUI(){
  // sign out buttons
  $('#top-signout')?.addEventListener('click', doLogout);
  $('#sidebar-signout')?.addEventListener('click', doLogout);

  // refresh (network fetch)
  $('#btnRefresh')?.addEventListener('click', loadReal);

  // ---- local filtering (no network) ----
  const runFilter = () => { tbl.pageIndex = 0; tbl.applyFilters(); };
  $('#q')?.addEventListener('input', debounce(runFilter, 200));
  $('#fStatus')?.addEventListener('change', runFilter);
  $('#fEval')?.addEventListener('change', runFilter);

  // pagination
  $('#prev-page')?.addEventListener('click', () => {
    if (tbl.pageIndex > 0){
      tbl.pageIndex--;
      tbl.renderTable(currentVisibleKeys());
    }
  });
  $('#next-page')?.addEventListener('click', () => {
    const totalPages = Math.ceil(tbl.viewRows.length / tbl.pageSize) || 1;
    if (tbl.pageIndex < totalPages - 1){
      tbl.pageIndex++;
      tbl.renderTable(currentVisibleKeys());
    }
  });

  // columns panel
  $('#btnColumns')?.addEventListener('click', views.openColumnsPanel);
  $('#close-columns')?.addEventListener('click', views.closeColumnsPanel);
  $('#columns-cancel')?.addEventListener('click', views.closeColumnsPanel);
  $('#columns-save')?.addEventListener('click', views.saveColumnsPanel);
}

// Backstop: if the sidebar re-renders, signout still works
document.addEventListener('click', (e) => {
  const t = e.target?.closest?.('#sidebar-signout');
  if (t) doLogout(e);
});

function currentVisibleKeys(){
  const ths = Array.from(document.querySelectorAll('#subsHead th[data-key]'))
    .filter(th => th.style.display !== 'none');
  return ths.map(th => th.dataset.key);
}

async function doLogin(){
  const pass = $('#pass')?.value?.trim() || '';
  const errEl = $('#err');
  if (errEl) errEl.textContent = '';

  try {
    const res = await fetch('/api/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ pass })
    });
    const j = await res.json().catch(() => ({}));

    if (!res.ok || j.ok !== true) {
      if (errEl) errEl.textContent = (j.error === 'invalid_pass' ? 'Invalid passcode' : (j.error || 'Login failed'));
      return;
    }

    $('#login')?.classList.add('hide');
    $('#shell')?.classList.remove('hide');

    wireUI();
    views.initViews();
    loadReal();
  } catch {
    if (errEl) errEl.textContent = 'Network error';
  }
}

function bindLoginHandlers(){
  const btn = $('#btnLogin');
  const passEl = $('#pass');
  window.__psaLogin = doLogin;
  btn?.addEventListener('click', doLogin);
  if (btn) btn.onclick = doLogin;
  passEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}

async function loadReal(){
  const err = $('#subsErr');
  if (err) { err.classList.add('hide'); err.textContent = ''; }

  try {
    // Fetch once; all filtering is client-side
    const items = await fetchSubmissions();

    tbl.setRows(items.map(tbl.normalizeRow));

    // Ensure header is painted for the current view, then apply filters
    views.applyView(views.currentView);
    tbl.applyFilters();

    $('#countPill') && ($('#countPill').textContent = String(tbl.viewRows.length));
  } catch (e) {
    if (err) { err.textContent = e.message || 'Load failed'; err.classList.remove('hide'); }
    console.error('[admin] loadReal error:', e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const authed = /(?:^|;\s*)psa_admin=/.test(document.cookie);

  // auth note labels (null-safe)
  const authNote = $('#auth-note');     if (authNote) authNote.textContent = authed ? 'passcode session' : 'not signed in';
  const authNoteTop = $('#auth-note-top'); if (authNoteTop) authNoteTop.textContent = authed ? 'passcode session' : 'not signed in';

  bindLoginHandlers();

  if (authed) {
    $('#login')?.classList.add('hide');
    $('#shell')?.classList.remove('hide');
    wireUI();
    views.initViews();
    loadReal();
  } else {
    $('#login')?.classList.remove('hide');
    $('#shell')?.classList.add('hide');
  }
});
