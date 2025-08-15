import { $, show, hide, hasCookie, debounce } from './util.js';
import { fetchSubmissions, login, logout } from './api.js';
import * as tbl from './table.js';
import * as views from './views.js';

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
  const passEl = $('#pass');
  const pass = passEl?.value?.trim() || '';
  if ($('#err')) $('#err').textContent = '';

  // quick guard so clicks always do something visible in DevTools
  console.debug('[PSA Admin] Sign in clicked');

  const { ok, error } = await login(pass);
  if (!ok) {
    if ($('#err')) {
      $('#err').textContent = (error === 'invalid_pass' ? 'Invalid passcode' : (error || 'Login failed'));
    }
    return;
  }
  location.replace('/admin');
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
    const items = await fetchSubmissions(q);
    tbl.allRows = items.map(tbl.normalizeRow);

    // ensure header exists per current view, then filter/sort and paint
    views.applyView(views.currentView);
    tbl.applyFilters();
    if ($('#countPill')) $('#countPill').textContent = String(tbl.viewRows.length);
  } catch (e) {
    if (err) { err.textContent = e.message || 'Load failed'; err.classList.remove('hide'); }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const authed = hasCookie('psa_admin');

  // Fail-safe: default to showing login so the page is never blank during setup
  const loginEl = $('#login');
  const shellEl = $('#shell');
  if (loginEl && shellEl) { show('login'); hide('shell'); }

  // Auth note labels (guarded)
  const authNote = $('#auth-note');
  if (authNote) authNote.textContent = authed ? 'passcode session' : 'not signed in';
  const authNoteTop = $('#auth-note-top');
  if (authNoteTop) authNoteTop.textContent = authed ? 'passcode session' : 'not signed in';

  // Toggle shell/login based on cookie
  if (loginEl && shellEl) {
    if (authed) { show('shell'); hide('login'); }
    else { show('login'); hide('shell'); }
  }

  // Login handlers (always wired)
  bindLoginHandlers();

  // If not authed, stop here (login UI is visible)
  if (!authed) return;

  // Authed: wire UI + views and load data
  wireUI();
  views.initViews();
  loadReal();
});
