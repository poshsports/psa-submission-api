import { $, debounce } from './util.js';
import { fetchSubmissions, logout } from './api.js';
import * as tbl from './table.js';
import * as views from './views.js';

window.__tbl = tbl; // DevTools
// Expose logout so we can call it from HTML / console if needed
async function doLogout(e){
  e?.preventDefault?.();
  try { await logout(); } catch {}
  // Always leave the page, even if the POST fails
  window.location.replace('/admin');
}
window.__doLogout = doLogout;

function ensureSignoutWired(){
  const el = $('#sidebar-signout');
  if (!el) return;
  // Wire both styles to be extra safe
  el.addEventListener('click', doLogout);
  el.onclick = doLogout;
}

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

  // pagination
  $('#prev-page')?.addEventListener('click', () => {
    if (tbl.pageIndex > 0){
      tbl.pageIndex--;
      tbl.renderTable(currentVisibleKeys());
      updateCountPill();
    }
  });
  $('#next-page')?.addEventListener('click', () => {
    const totalPages = Math.ceil(tbl.viewRows.length / tbl.pageSize) || 1;
    if (tbl.pageIndex < totalPages - 1){
      tbl.pageIndex++;
      tbl.renderTable(currentVisibleKeys());
      updateCountPill();
    }
  });

  // columns panel (button now lives in the views bar; we also set onclick there)
  $('#close-columns')?.addEventListener('click', views.closeColumnsPanel);
  $('#columns-cancel')?.addEventListener('click', views.closeColumnsPanel);
  $('#columns-save')?.addEventListener('click', views.saveColumnsPanel);
}

// Global backstop: if something re-renders the sidebar, this still works
document.addEventListener('click', (e) => {
  const t = e.target && e.target.closest && e.target.closest('#sidebar-signout');
  if (t) doLogout(e);
});

function currentVisibleKeys(){
  const ths = Array.from(document.querySelectorAll('#subsHead th[data-key]'))
    .filter(th => th.style.display !== 'none');
  return ths.map(th => th.dataset.key);
}

async function doLogin(){
  const pass = document.getElementById('pass')?.value?.trim() || '';
  const errEl = document.getElementById('err');
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
      if (errEl) errEl.textContent = (j.error === 'invalid_pass'
        ? 'Invalid passcode'
        : (j.error || 'Login failed'));
      return;
    }

    // Cookie is set. Flip UI in place and initialize the shell (no reload).
    const loginEl = document.getElementById('login');
    const shellEl = document.getElementById('shell');
    if (loginEl) loginEl.classList.add('hide');
    if (shellEl) shellEl.classList.remove('hide');

    wireUI();
    views.initViews();
    loadReal();
  } catch (e) {
    if (errEl) errEl.textContent = 'Network error';
  }
}

// console fallback so you can trigger manually if needed
// in DevTools:  __psaLogin()
function bindLoginHandlers(){
  const btn = $('#btnLogin');
  const passEl = $('#pass');
  window.__psaLogin = doLogin;
  if (btn) { btn.addEventListener('click', doLogin); btn.onclick = doLogin; }
  if (passEl) passEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}

function updateCountPill(){
  const pill = $('#countPill');
  if (pill) pill.textContent = String(tbl.viewRows.length);
}

async function loadReal(){
  const err = $('#subsErr');
  if (err) { err.classList.add('hide'); err.textContent = ''; }

  try {
    // get ALL items; filtering is client-side
    const items = await fetchSubmissions(); 

    tbl.setRows(items.map(tbl.normalizeRow));

    // ensure header, then apply current UI filters
    views.applyView(views.currentView);  // sets header and calls tbl.applyFilters()
    tbl.applyFilters();                  // ok to call again

    const countPill = $('#countPill');
    if (countPill) countPill.textContent = String(tbl.viewRows.length);
  } catch (e) {
    if (err) { err.textContent = e.message || 'Load failed'; err.classList.remove('hide'); }
    console.error('[admin] loadReal error:', e);
  }
}


document.addEventListener('DOMContentLoaded', () => {
  const authed = /(?:^|;\s*)psa_admin=/.test(document.cookie);

  const loginEl = document.getElementById('login');
  const shellEl = document.getElementById('shell');

  const authNote = document.getElementById('auth-note');
  if (authNote) authNote.textContent = authed ? 'passcode session' : 'not signed in';
  const authNoteTop = document.getElementById('auth-note-top');
  if (authNoteTop) authNoteTop.textContent = authed ? 'passcode session' : 'not signed in';

  // Always wire login controls
  bindLoginHandlers();

  if (authed) {
    if (loginEl) loginEl.classList.add('hide');
    if (shellEl) shellEl.classList.remove('hide');

    wireUI();
    views.initViews();
    loadReal();
  } else {
    if (loginEl) loginEl.classList.remove('hide');
    if (shellEl) shellEl.classList.add('hide');
  }
});
