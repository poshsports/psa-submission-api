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
  const el = $('sidebar-signout');
  if (!el) return;
  // Wire both styles to be extra safe
  el.addEventListener('click', doLogout);
  el.onclick = doLogout;
}

// Single place to run client-side filters + update count
function runFilter(){
  tbl.setPageIndex(0);     // <-- instead of tbl.pageIndex = 0
  tbl.applyFilters();
  const pill = $('countPill');
  if (pill) pill.textContent = String(tbl.viewRows.length);
}

function buildServiceOptions(){
  const sel = $('fService');
  if (!sel) return;
  const seen = new Set();
  tbl.rows.forEach(r => {
    const v = (r.grading_service || r.service || r.grading || '').trim();
    if (v) seen.add(v);
  });
  const cur = sel.value;
  sel.innerHTML = '<option value="">Grading: All</option>' +
    Array.from(seen).sort().map(v => `<option>${v}</option>`).join('');
  if (cur && Array.from(seen).includes(cur)) sel.value = cur;
}

function positionPopover(pop, anchor){
  const r = anchor.getBoundingClientRect();
  pop.style.top  = `${window.scrollY + r.bottom + 6}px`;
  pop.style.left = `${Math.min(window.scrollX + r.left, window.scrollX + (window.innerWidth - pop.offsetWidth - 10))}px`;
}

function updateDateButtonLabel(){
  const btn = $('btnDate'); if (!btn) return;
  const f = $('dateFrom')?.value, t = $('dateTo')?.value;

  if (!f && !t){ btn.textContent = 'Dates: All'; return; }

  const fmt = s => {
    const [y,m,d] = s.split('-'); return `${m}/${d}`;
  };
  // quick detection of presets (optional nicety)
  const today = new Date(); today.setHours(0,0,0,0);
  const fMs = f ? Date.parse(f) : null;
  const tMs = t ? Date.parse(t) : null;
  const day = 86400000;

  if (fMs && tMs){
    const span = Math.round((tMs - fMs)/day) + 1;
    if (span === 1 && tMs === today.getTime()) { btn.textContent = 'Dates: Today'; return; }
    if (span === 7 && tMs === today.getTime()) { btn.textContent = 'Dates: Last 7 days'; return; }
    if (span === 30 && tMs === today.getTime()) { btn.textContent = 'Dates: Last 30 days'; return; }
  }
  btn.textContent = `Dates: ${f?fmt(f):'…'}–${t?fmt(t):'…'}`;
}

function openDatePopover(){
  const pop = $('date-popover'); const btn = $('btnDate');
  if (!pop || !btn) return;
  pop.classList.remove('hide');
  positionPopover(pop, btn);

  // close on clicks outside / Esc
  const onDoc = (e) => {
    if (!pop.contains(e.target) && e.target !== btn) { closeDatePopover(); }
  };
  const onEsc = (e) => { if (e.key === 'Escape') closeDatePopover(); };
  pop.__off = () => { document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onEsc, true); };
  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onEsc, true);
}

function closeDatePopover(){
  const pop = $('date-popover'); if (!pop) return;
  pop.classList.add('hide'); pop.__off?.(); pop.__off = null;
}

function setPreset(days){  // days=1 for today, 7, 30
  const to = new Date(); to.setHours(0,0,0,0);
  const from = new Date(to.getTime() - (days-1)*86400000);
  const pad = n => String(n).padStart(2,'0');
  const val = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  $('dateFrom').value = val(from);
  $('dateTo').value   = val(to);
}

function applyDateAndFilter(){
  closeDatePopover();
  updateDateButtonLabel();
  runFilter();
}

function wireUI(){
  // sign out (sidebar only)
  ensureSignoutWired();

  // refresh (re-fetch)
  $('btnRefresh')?.addEventListener('click', loadReal);

  // ---- local filtering (instant; no network) ----
  const debouncedFilter = debounce(runFilter, 150);
  $('q')?.addEventListener('input', debouncedFilter);
  $('fStatus')?.addEventListener('change', runFilter);
  $('fEval')?.addEventListener('change', runFilter);

  // NEW: grading service filter
  $('fService')?.addEventListener('change', runFilter);

  // NEW: date popover wiring
  $('btnDate')?.addEventListener('click', openDatePopover);
  $('datePresetToday')?.addEventListener('click', () => { setPreset(1); });
  $('datePreset7')?.addEventListener('click',    () => { setPreset(7); });
  $('datePreset30')?.addEventListener('click',   () => { setPreset(30); });
  $('dateClear')?.addEventListener('click', () => { $('dateFrom').value=''; $('dateTo').value=''; });
  $('dateCancel')?.addEventListener('click', closeDatePopover);
  $('dateApply')?.addEventListener('click', applyDateAndFilter);

// pagination
$('prev-page')?.addEventListener('click', () => {
  tbl.prevPage();                              // <-- helper, not direct write
  tbl.renderTable(currentVisibleKeys());
  updateCountPill();
});
$('next-page')?.addEventListener('click', () => {
  tbl.nextPage();                              // <-- helper, not direct write
  tbl.renderTable(currentVisibleKeys());
  updateCountPill();
});


  // columns panel (open + close/save)
  $('btnColumns')?.addEventListener('click', views.openColumnsPanel);
  $('close-columns')?.addEventListener('click', views.closeColumnsPanel);
  $('columns-cancel')?.addEventListener('click', views.closeColumnsPanel);
  $('columns-save')?.addEventListener('click', views.saveColumnsPanel);
}

// Fallback delegation: if toolbar nodes are re-rendered, filtering still works
document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'q') runFilter();
}, true);

document.addEventListener('change', (e) => {
  const id = e.target && e.target.id;
  if (id === 'fStatus' || id === 'fEval' || id === 'fService') runFilter();
}, true);

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
    const btn = $('btnLogin');
    const passEl = $('pass');
  window.__psaLogin = doLogin;
  if (btn) { btn.addEventListener('click', doLogin); btn.onclick = doLogin; }
  if (passEl) passEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}

function updateCountPill(){
  const pill = $('countPill')
  if (pill) pill.textContent = String(tbl.viewRows.length);
}

async function loadReal(){
  const err = $('#subsErr');
  if (err) { err.classList.add('hide'); err.textContent = ''; }

  try {
    // Get ALL items; filtering is client-side
    const items = await fetchSubmissions();            // <-- no `q` here
    tbl.setRows(items.map(tbl.normalizeRow));
    buildServiceOptions();

    // Ensure header/sort, then apply current UI filters + update count
    views.applyView(views.currentView);
    runFilter();                                       // pageIndex=0, applyFilters, update pill
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
