import { $, show, hide, hasCookie, debounce } from './util.js';
import { fetchSubmissions, login, logout } from './api.js';
import * as tbl from './table.js';
import * as views from './views.js';

function wireUI(){
  // sign out buttons
  $('#top-signout').onclick = doLogout;
  $('#sidebar-signout').onclick = doLogout;

  // refresh + search
  $('#btnRefresh').onclick = loadReal;
  $('#q').addEventListener('input', debounce(loadReal, 250));

  // pagination
  $('#prev-page').onclick = () => { if (tbl.pageIndex>0){ tbl.pageIndex--; tbl.renderTable(currentVisibleKeys()); } };
  $('#next-page').onclick = () => {
    const totalPages = Math.ceil(tbl.viewRows.length / tbl.pageSize);
    if (tbl.pageIndex < totalPages-1){ tbl.pageIndex++; tbl.renderTable(currentVisibleKeys()); }
  };

  // columns panel
  $('#btnColumns').onclick = views.openColumnsPanel;
  $('#close-columns').onclick = views.closeColumnsPanel;
  $('#columns-cancel').onclick = views.closeColumnsPanel;
  $('#columns-save').onclick = views.saveColumnsPanel;
}

function currentVisibleKeys(){
  const ths = Array.from(document.querySelectorAll('#subsHead th[data-key]')).filter(th => th.style.display !== 'none');
  return ths.map(th => th.dataset.key);
}

async function doLogout(e){
  e?.preventDefault?.();
  await logout();
  window.location.replace('/admin');
}

async function doLogin(){
  const pass = $('#pass').value.trim();
  $('#err').textContent = '';
  const { ok, error } = await login(pass);
  if (!ok) { $('#err').textContent = (error === 'invalid_pass' ? 'Invalid passcode' : (error || 'Login failed')); return; }
  location.replace('/admin');
}

async function loadReal(){
  const err = $('#subsErr'); err.classList.add('hide'); err.textContent = '';
  try {
    const q = ($('#q')?.value || '').trim();
    const items = await fetchSubmissions(q);
    tbl.allRows = items.map(tbl.normalizeRow);

    // ensure header exists per current view, then filter/sort and paint
    views.applyView(views.currentView);
    tbl.applyFilters();
    $('#countPill').textContent = String(tbl.viewRows.length);
  } catch (e) {
    err.textContent = e.message || 'Load failed';
    err.classList.remove('hide');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Auth gate
  const authed = hasCookie('psa_admin');

  const authNote = $('#auth-note');
  if (authNote) authNote.textContent = authed ? 'passcode session' : 'not signed in';

  const authNoteTop = $('#auth-note-top');
  if (authNoteTop) authNoteTop.textContent = authed ? 'passcode session' : 'not signed in';

  const hasLogin = !!$('#login');
  const hasShell = !!$('#shell');

  if (hasLogin && hasShell) {
    if (authed) { show('shell'); hide('login'); }
    else { show('login'); hide('shell'); }
  }

  // Login
  $('#btnLogin')?.addEventListener('click', doLogin);
  $('#pass')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  if (!authed) return;

  // Wire UI + views and load data
  wireUI();
  views.initViews();
  loadReal();
});
