import { $, debounce } from './util.js';
import { fetchSubmissions, logout } from './api.js';
import * as tbl from './table.js';
import * as views from './views.js';

window.__tbl = tbl; // <-- lets us inspect table state in DevTools


function wireUI(){
  // sign out buttons
  $('#top-signout')?.addEventListener('click', doLogout);
  $('#sidebar-signout')?.addEventListener('click', doLogout);

  // refresh + search
  $('#btnRefresh')?.addEventListener('click', loadReal);
  $('#q')?.addEventListener('input', debounce(loadReal, 250));

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

function currentVisibleKeys(){
  const ths = Array.from(document.querySelectorAll('#subsHead th[data-key]'))
    .filter(th => th.style.display !== 'none');
  return ths.map(th => th.dataset.key);
}

async function doLogout(e){
  e?.preventDefault?.();
  await logout();
  window.location.replace('/admin');
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
      if (errEl) errEl.textContent = (j.error === 'invalid_pass' ? 'Invalid passcode' : (j.error || 'Login failed'));
      return;
    }

    // Cookie is set. Flip UI in place and initialize the shell (no reload).
    const loginEl = document.getElementById('login');
    const shellEl = document.getElementById('shell');
    if (loginEl) loginEl.classList.add('hide');
    if (shellEl) shellEl.classList.remove('hide');


    // Wire the rest of the app now that we’re “authed”
    wireUI();
    views.initViews();
    loadReal();
  } catch (e) {
    if (errEl) errEl.textContent = 'Network error';
  }
}

// extra-defensive: wire both addEventListener and onclick, plus an Enter key handler
function bindLoginHandlers(){
  const btn = $('#btnLogin');
  const passEl = $('#pass');

  // console fallback so you can trigger manually if needed
  // in DevTools:  __psaLogin()
  window.__psaLogin = doLogin;

  if (btn) {
    btn.addEventListener('click', doLogin);
    btn.onclick = doLogin; // belt + suspenders in case something removes listeners
  }
  if (passEl) {
    passEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  }
}

async function loadReal(){
  const err = $('#subsErr');
  if (err) { err.classList.add('hide'); err.textContent = ''; }

  try {
    const q = ($('#q')?.value || '').trim();

    // 1) Fetch raw items
    const items = await fetchSubmissions(q);
    console.debug('[admin] fetch ok, items:', items.length, items[0]);

    // 2) Normalize + assign to table state
    tbl.setRows(items.map(tbl.normalizeRow));
    console.debug('[admin] normalized rows:', tbl.allRows.length, tbl.allRows[0]);

    // 3) Ensure header + render
    views.applyView(views.currentView);   // sets header & calls tbl.applyFilters()
    tbl.applyFilters();                   // explicit second call is fine

    // 4) Update count
    const countPill = $('#countPill');
    if (countPill) countPill.textContent = String(tbl.viewRows.length);

    // 5) Sanity: how many table rows did we paint?
    const trCount = document.querySelectorAll('#subsTbody tr').length;
    console.debug('[admin] tbody <tr> count:', trCount);

  } catch (e) {
    if (err) { err.textContent = e.message || 'Load failed'; err.classList.remove('hide'); }
    console.error('[admin] loadReal error:', e);
  }
}


document.addEventListener('DOMContentLoaded', () => {
  // Detect auth strictly from the cookie
  const authed = /(?:^|;\s*)psa_admin=/.test(document.cookie);

  const loginEl = document.getElementById('login');
  const shellEl = document.getElementById('shell');

  // Auth note labels (guarded)
  const authNote = document.getElementById('auth-note');
  if (authNote) authNote.textContent = authed ? 'passcode session' : 'not signed in';
  const authNoteTop = document.getElementById('auth-note-top');
  if (authNoteTop) authNoteTop.textContent = authed ? 'passcode session' : 'not signed in';

  // Always wire login controls
  const btn = document.getElementById('btnLogin');
  const passEl = document.getElementById('pass');
  window.__psaLogin = doLogin;  // console fallback
  if (btn) { btn.addEventListener('click', doLogin); btn.onclick = doLogin; }
  if (passEl) passEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  if (authed) {
    // Show shell and load content
    if (loginEl) loginEl.classList.add('hide');
    if (shellEl) shellEl.classList.remove('hide');

    wireUI();
    views.initViews();
    loadReal();
  } else {
    // Show login only
    if (loginEl) loginEl.classList.remove('hide');
    if (shellEl) shellEl.classList.add('hide');
  }
});
