// /admin/js/admin.app.js
import { $, debounce, escapeHtml } from './util.js';
import { fetchSubmissions, logout, fetchSubmission } from './api.js';
import * as tbl from './table.js';
import * as views from './views.js';

window.__tbl = tbl; // DevTools

// ===== sign out =====
async function doLogout(e){
  e?.preventDefault?.();
  try { await logout(); } catch {}
  window.location.replace('/admin'); // Always leave the page
}
window.__doLogout = doLogout;

function ensureSignoutWired(){
  const el = $('sidebar-signout');
  if (!el) return;
  el.addEventListener('click', doLogout);
  el.onclick = doLogout;
}

// ===== filters & counters =====
function runFilter(){
  tbl.setPageIndex(0);
  tbl.applyFilters();
  updateCountPill();
}

function buildServiceOptions(){
  const sel = $('fService');
  if (!sel) return;
  const seen = new Set();
  (tbl.allRows || []).forEach(r => {
    const v = (r.grading_service || r.service || r.grading || '').trim();
    if (v) seen.add(v);
  });
  const cur = sel.value;
  sel.innerHTML = '<option value="">Grading: All</option>' +
    Array.from(seen).sort().map(v => `<option>${v}</option>`).join('');
  if (cur && Array.from(seen).includes(cur)) sel.value = cur;
}

// ===== popover placement =====
function positionPopover(pop, anchor){
  const r = anchor.getBoundingClientRect();
  pop.style.top  = `${window.scrollY + r.bottom + 6}px`;
  pop.style.left = `${Math.min(window.scrollX + r.left, window.scrollX + (window.innerWidth - pop.offsetWidth - 10))}px`;
}

// ===== button label for dates =====
function updateDateButtonLabel(){
  const btn = $('btnDate'); if (!btn) return;
  const f = $('dateFrom')?.value, t = $('dateTo')?.value;

  if (!f && !t){ btn.textContent = 'Dates: All'; return; }

  const fmt = s => { const [y,m,d] = s.split('-'); return `${m}/${d}`; };

  const today = new Date(); today.setHours(0,0,0,0);
  const fMs = f ? Date.parse(f) : null;
  const tMs = t ? Date.parse(t) : null;
  const day = 86400000;

  if (fMs && tMs){
    const span = Math.round((tMs - fMs)/day) + 1;
    if (span === 1  && tMs === today.getTime()) { btn.textContent = 'Dates: Today'; return; }
    if (span === 7  && tMs === today.getTime()) { btn.textContent = 'Dates: Last 7 days'; return; }
    if (span === 30 && tMs === today.getTime()) { btn.textContent = 'Dates: Last 30 days'; return; }
  }
  btn.textContent = `Dates: ${f?fmt(f):'…'}–${t?fmt(t):'…'}`;
}

// ===================================================================
// Range calendar (two-month) with hover & second-click apply
// ===================================================================
const DOW = ['S','M','T','W','T','F','S'];
const MONTH_FMT = { month: 'long', year: 'numeric' };

let selStart = null;    // Date | null (midnight)
let selEnd   = null;    // Date | null (midnight)
let hoverDay = null;    // Date | null (midnight)
let monthCursor = null; // Date (first day of left month)

const mid = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const fmtYMD = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const parseYMD = s => { const [y,m,d] = s.split('-').map(n=>+n); const x = new Date(y, m-1, d); x.setHours(0,0,0,0); return x; };
const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth()+n, 1);
const sameDate = (a,b) => a && b && a.getTime() === b.getTime();

function paintRangeClasses(){
  const cells = document.querySelectorAll('#date-popover .rc-cell');

  let a = selStart ? mid(selStart) : null;
  let b = selEnd ? mid(selEnd) : (selStart && hoverDay ? mid(hoverDay) : null);

  let lo = null, hi = null;
  if (a && b){ if (a > b) [a, b] = [b, a]; lo = a; hi = b; }

  cells.forEach(cell => {
    const d = parseYMD(cell.dataset.date);
    cell.classList.remove('rc-in-range','rc-start','rc-end');
    if (selStart && sameDate(d, selStart)) cell.classList.add('rc-start');
    if (selEnd   && sameDate(d, selEnd))   cell.classList.add('rc-end');
    if (lo && hi && d >= lo && d <= hi)    cell.classList.add('rc-in-range');
  });

  const lab = $('rc-range-label');
  if (lab){
    if (a && b){
      const min = a <= b ? a : b, max = a <= b ? b : a;
      lab.textContent = `${min.toLocaleDateString()} – ${max.toLocaleDateString()}`;
    } else lab.textContent = '';
  }
}

function ensureDowRow(gridEl){
  const monthEl = gridEl.closest('.rc-month');
  if (!monthEl) return;
  let dow = monthEl.querySelector('.rc-dow');
  if (!dow){
    dow = document.createElement('div');
    dow.className = 'rc-dow';
    DOW.forEach(ch => { const s = document.createElement('div'); s.textContent = ch; dow.appendChild(s); });
    monthEl.insertBefore(dow, gridEl);
  } else if (!dow.firstChild) {
    DOW.forEach(ch => { const s = document.createElement('div'); s.textContent = ch; dow.appendChild(s); });
  }
}

function buildMonth(titleEl, gridEl, monthFirstDate){
  if (!titleEl || !gridEl) return;

  titleEl.textContent = monthFirstDate.toLocaleString(undefined, MONTH_FMT);
  gridEl.innerHTML = '';
  ensureDowRow(gridEl);

  const firstDow = monthFirstDate.getDay();
  const gridStart = new Date(monthFirstDate);
  gridStart.setDate(1 - firstDow);
  gridStart.setHours(0,0,0,0);

  const rngA = selStart ? mid(selStart) : null;
  const rngB = selEnd ? mid(selEnd) : (selStart && hoverDay ? mid(hoverDay) : null);
  let minR = null, maxR = null;
  if (rngA && rngB) {
    if (rngA.getTime() <= rngB.getTime()) { minR = rngA; maxR = rngB; }
    else { minR = rngB; maxR = rngA; }
  }

  for (let i = 0; i < 42; i++){
    const d = new Date(gridStart); d.setDate(gridStart.getDate()+i);
    const cell = document.createElement('div');
    cell.className = 'rc-cell';
    cell.dataset.date = fmtYMD(d);
    cell.textContent = String(d.getDate());
    if (d.getMonth() !== monthFirstDate.getMonth()) cell.classList.add('rc-muted');

    if (rngA){
      if (minR && maxR && d.getTime() >= minR.getTime() && d.getTime() <= maxR.getTime()){
        cell.classList.add('rc-in-range');
      }
      if (sameDate(d, rngA)) cell.classList.add('rc-start');
      if (selEnd && sameDate(d, selEnd)) cell.classList.add('rc-end');
    }

    cell.addEventListener('mouseenter', () => {
      if (selStart && !selEnd){ hoverDay = mid(parseYMD(cell.dataset.date)); paintRangeClasses(); }
    });

    cell.addEventListener('click', () => {
      const d2 = mid(parseYMD(cell.dataset.date));
      if (!selStart || (selStart && selEnd)){
        selStart = d2; selEnd = null; hoverDay = d2; paintRangeClasses();
      } else {
        let a = selStart, b = d2;
        if (b.getTime() < a.getTime()) [a, b] = [b, a];
        selStart = a; selEnd = b; hoverDay = null;

        const from = $('dateFrom'), to = $('dateTo');
        if (from) from.value = fmtYMD(a);
        if (to)   to.value   = fmtYMD(b);

        updateDateButtonLabel();
        paintRangeClasses(); // keep open for Apply
      }
    });

    gridEl.appendChild(cell);
  }
}

function paintCalendars(){
  const pop = $('date-popover');
  if (!pop || pop.classList.contains('hide')) return;

  const titleL = $('rc-title-left');
  const titleR = $('rc-title-right');
  const gridL  = $('rc-grid-left');
  const gridR  = $('rc-grid-right');

  const leftMonth  = startOfMonth(monthCursor || new Date());
  const rightMonth = addMonths(leftMonth, 1);

  buildMonth(titleL, gridL, leftMonth);
  buildMonth(titleR, gridR, rightMonth);

  paintRangeClasses();

  $('rc-grid-left')?.addEventListener('mouseleave', () => {
    if (selStart && !selEnd){ hoverDay = null; paintRangeClasses(); }
  }, { once:true });
  $('rc-grid-right')?.addEventListener('mouseleave', () => {
    if (selStart && !selEnd){ hoverDay = null; paintRangeClasses(); }
  }, { once:true });
}

// ===== popover open/close =====
function openDatePopover(){
  const pop = $('date-popover'); const btn = $('btnDate');
  if (!pop || !btn) return;
  if (!pop.classList.contains('hide')) { closeDatePopover(); return; }

  const f = $('dateFrom')?.value || '';
  const t = $('dateTo')?.value   || '';
  selStart = f ? parseYMD(f) : null;
  selEnd   = t ? parseYMD(t) : null;
  hoverDay = null;

  const base = selStart || new Date();
  monthCursor = startOfMonth(base);

  pop.classList.remove('hide');
  positionPopover(pop, btn);

  $('rc-prev').onclick = () => { monthCursor = addMonths(monthCursor, -1); paintCalendars(); };
  $('rc-next').onclick = () => { monthCursor = addMonths(monthCursor, +1); paintCalendars(); };

  paintCalendars();

  const onDoc = (e) => { if (!pop.contains(e.target) && e.target !== btn) closeDatePopover(); };
  const onEsc = (e) => { if (e.key === 'Escape') closeDatePopover(); };
  pop.__off = () => {
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onEsc, true);
  };
  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onEsc, true);
}

function closeDatePopover(){
  const pop = $('date-popover'); if (!pop) return;
  pop.classList.add('hide'); pop.__off?.(); pop.__off = null;
}

function setPreset(days){
  const to = new Date(); to.setHours(0,0,0,0);
  const from = new Date(to.getTime() - (days-1)*86400000);
  const pad = n => String(n).padStart(2,'0');
  const val = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  $('dateFrom').value = val(from);
  $('dateTo').value   = val(to);

  selStart = mid(from); selEnd = mid(to); hoverDay = null;
  monthCursor = startOfMonth(selStart);
  paintCalendars();
}

function applyDateAndFilter(){
  closeDatePopover();
  updateDateButtonLabel();
  runFilter();
}

function resetFilters(){
  closeDatePopover?.();
  const q = $('q'); if (q) q.value = '';
  const s = $('fStatus'); if (s) s.value = 'all';
  const e = $('fEval');   if (e) e.value = 'all';
  const g = $('fService');if (g) g.value = '';

  const from = $('dateFrom'), to = $('dateTo');
  if (from) from.value = '';
  if (to)   to.value   = '';
  selStart = selEnd = hoverDay = null;

  updateDateButtonLabel();
  runFilter();
}

// ===== UI wiring =====
function wireUI(){
  ensureSignoutWired();

  $('btnRefresh')?.addEventListener('click', loadReal);
  $('btnResetFilters')?.addEventListener('click', resetFilters);

  const debouncedFilter = debounce(runFilter, 150);
  $('q')?.addEventListener('input', debouncedFilter);
  $('fStatus')?.addEventListener('change', runFilter);
  $('fEval')?.addEventListener('change', runFilter);

  $('fService')?.addEventListener('change', runFilter);

  $('btnDate')?.addEventListener('click', openDatePopover);
  $('datePresetToday')?.addEventListener('click', () => { setPreset(1);  updateDateButtonLabel(); });
  $('datePreset7')?.addEventListener('click',    () => { setPreset(7);  updateDateButtonLabel(); });
  $('datePreset30')?.addEventListener('click',   () => { setPreset(30); updateDateButtonLabel(); });
  $('dateClear')?.addEventListener('click', () => {
    $('dateFrom').value=''; $('dateTo').value='';
    selStart = selEnd = hoverDay = null;
    updateDateButtonLabel(); paintCalendars();
  });
  $('dateCancel')?.addEventListener('click', closeDatePopover);
  $('dateApply')?.addEventListener('click', applyDateAndFilter);

  $('dateFrom')?.addEventListener('change', updateDateButtonLabel);
  $('dateTo')?.addEventListener('change', updateDateButtonLabel);

  $('prev-page')?.addEventListener('click', () => {
    tbl.prevPage();
    tbl.renderTable(currentVisibleKeys());
    updateCountPill();
  });
  $('next-page')?.addEventListener('click', () => {
    tbl.nextPage();
    tbl.renderTable(currentVisibleKeys());
    updateCountPill();
  });

  $('btnColumns')?.addEventListener('click', views.openColumnsPanel);
  $('close-columns')?.addEventListener('click', views.closeColumnsPanel);
  $('columns-cancel')?.addEventListener('click', views.closeColumnsPanel);
  $('columns-save')?.addEventListener('click', views.saveColumnsPanel);

  wireRowClickDelegation();
}

// Fallback delegation
document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'q') runFilter();
}, true);
document.addEventListener('change', (e) => {
  const id = e.target && e.target.id;
  if (id === 'fStatus' || id === 'fEval' || id === 'fService') runFilter();
}, true);
document.addEventListener('click', (e) => {
  const t = e.target && e.target.closest && e.target.closest('#sidebar-signout');
  if (t) doLogout(e);
});

function currentVisibleKeys(){
  const ths = Array.from(document.querySelectorAll('#subsHead th[data-key]'))
    .filter(th => th.style.display !== 'none');
  return ths.map(th => th.dataset.key);
}

// ===================================================================
// Submission details (static #details-backdrop in index.html)
// ===================================================================
function ensureDetailsBackdropWired() {
  const back = $('details-backdrop');
  if (!back || back.__wired) return;
  back.__wired = true;

  const panel = back.querySelector('.details-panel');

  $('details-close')?.addEventListener('click', closeSubmissionDetails);
  $('details-close-2')?.addEventListener('click', closeSubmissionDetails);

  // click outside the panel closes
  back.addEventListener('mousedown', (e) => {
    if (!panel.contains(e.target)) closeSubmissionDetails();
  });

  // Esc closes
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSubmissionDetails();
  });
}

function openSubmissionDetailsPanel() {
  ensureDetailsBackdropWired();
  const back = $('details-backdrop');
  if (!back) return;
  back.classList.add('show');
  back.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  $('details-close')?.focus({ preventScroll: true });
}

function closeSubmissionDetails() {
  const back = $('details-backdrop');
  if (!back) return;
  back.classList.remove('show');
  back.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

// --- helpers for rendering ---
function pickFirst(...vals){
  for (const v of vals) {
    if (v != null && String(v).trim() !== '') return v;
  }
  return '';
}

function renderAddress(r) {
  const nested =
    r.shipping_address || r.shopify_shipping_address ||
    r.ship_address || r.ship_to || r.address || null;

  const name = pickFirst(r.ship_name, r.shipping_name, nested?.name, r.name, r.customer_name);
  const a1   = pickFirst(r.ship_addr1, r.address1, nested?.address1);
  const a2   = pickFirst(r.ship_addr2, r.address2, nested?.address2);
  const city = pickFirst(r.ship_city,  r.city,     nested?.city);
  const st   = pickFirst(r.ship_state, r.state,    nested?.state, nested?.province);
  const zip  = pickFirst(r.ship_zip,   r.zip,      nested?.zip, nested?.postal_code, nested?.postal);

  const parts = [name, a1, a2, [city, st, zip].filter(Boolean).join(', ')].filter(Boolean);
  if (!parts.length) return '';
  return `<address class="shipto">${parts.map(escapeHtml).join('<br>')}</address>`;
}

function renderCardsTable(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return '';

  const head = `
    <div class="ct-head">
      <div>Date of break</div>
      <div>Break channel</div>
      <div>Break #</div>
      <div>Card description</div>
    </div>
  `;

  const rows = cards.map(c => {
    const date = c.date || c.date_of_break || c.break_date || '';
    const chan = c.channel || c.break_channel || '';
    const num  = c.break_no || c.break_number || c.break || '';
    const desc = c.description || c.card_description || c.title || c.card || '';
    return `
      <div class="ct-row">
        <div>${escapeHtml(String(date || ''))}</div>
        <div>${escapeHtml(String(chan || ''))}</div>
        <div class="right">${escapeHtml(String(num || ''))}</div>
        <div>${escapeHtml(String(desc || ''))}</div>
      </div>
    `;
  }).join('');

  return `
    <h3 class="sheet-subhead" style="margin:12px 0 6px">Cards (${cards.length})</h3>
    <div class="cards-table">
      ${head}
      ${rows}
    </div>
  `;
}

function renderKV(label, valueHtml) {
  return `<dt>${escapeHtml(label)}</dt><dd>${valueHtml}</dd>`;
}
function renderIf(label, value) {
  if (value == null || value === '') return '';
  return renderKV(label, escapeHtml(String(value)));
}
function fmtMoney(n){ return `$${(Number(n)||0).toLocaleString()}`; }
function fmtDate(iso){
  try { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString(); }
  catch { return ''; }
}

async function openSubmissionDetails(id) {
  openSubmissionDetailsPanel();

  const titleEl = $('details-title');
  const bodyEl  = $('details-body');
  if (titleEl) titleEl.textContent = `Submission ${id}`;
  if (bodyEl)  bodyEl.innerHTML = `<div class="loading">Loading…</div>`;

  try {
    const r = await fetchSubmission(id);

    const evalAmtNum = Number(
      (r.evaluation ?? 0) || (r.eval_line_sub ?? 0) || (r?.totals?.evaluation ?? 0)
    ) || 0;
    const evalYesNo  = evalAmtNum > 0 ? 'Yes' : 'No';

    const grand   = r?.totals?.grand ?? r.grand_total ?? r.total ?? r.grand ?? 0;
    const paidAmt = r.paid_amount || 0;
    const cards   = r.card_info || r.cards || r.items || [];

    const shipHTML = renderAddress(r);

    const gridHTML = `
      <dl class="dl">
        ${renderKV('Submission', `<code>${escapeHtml(String(r.submission_id || r.id || id))}</code>`)}
        ${renderIf('Email', r.customer_email || r.email)}
        ${renderIf('Status', r.status)}
        ${renderKV('Created', escapeHtml(fmtDate(r.created_at || r.inserted_at || r.submitted_at_iso || r.submitted_at)))}
        ${renderKV('Cards', String(r.cards ?? (Array.isArray(cards) ? cards.length : 0)))}
        ${renderKV('Evaluation', evalYesNo)}
        ${renderKV('Grand', escapeHtml(fmtMoney(grand)))}
        ${renderIf('Grading Service', r.grading_service || r.grading_services || r.service || r.grading)}
        ${renderKV('Paid', escapeHtml(fmtMoney(paidAmt)))}
        ${r.shopify_order_name ? renderKV('Order', `<span class="pill">${escapeHtml(r.shopify_order_name)}</span>`) : ''}
        ${shipHTML ? renderKV('Ship-to', shipHTML) : ''}
      </dl>
    `;

    const cardsHTML = renderCardsTable(cards);
    const jsonHTML = `
      <details style="margin-top:12px">
        <summary>Raw JSON</summary>
        <pre class="json">${escapeHtml(JSON.stringify(r, null, 2))}</pre>
      </details>
    `;

    bodyEl.innerHTML = gridHTML + cardsHTML + jsonHTML;
  } catch (e) {
    bodyEl.innerHTML = `<div class="error">Failed to load details: ${escapeHtml(e.message || 'Error')}</div>`;
  }
}

// Allow other modules / inline HTML to open the sheet.
window.__openAdminDetails = (id, friendly) => openSubmissionDetails(id || friendly || '');

function wireRowClickDelegation(){
  const tb = $('subsTbody');
  if (!tb || tb.__wiredRowClick) return;
  tb.__wiredRowClick = true;

  tb.addEventListener('click', (e) => {
    const tr = e.target?.closest?.('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    if (!id) return;

    const a = e.target.closest('a');
    if (a) { e.preventDefault(); e.stopPropagation(); }

    openSubmissionDetails(id);
  }, true);

  tb.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const tr = e.target?.closest?.('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    if (!id) return;
    e.preventDefault();
    openSubmissionDetails(id);
  });
}

window.addEventListener('psa:open-details', (e) => {
  const { id, friendly } = e.detail || {};
  if (!id && !friendly) return;
  openSubmissionDetails(id || friendly);
});

// ===== auth & boot =====
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

    const loginEl = document.getElementById('login');
    const shellEl = document.getElementById('shell');
    if (loginEl) loginEl.classList.add('hide');
    if (shellEl) shellEl.classList.remove('hide');

    wireUI();
    updateDateButtonLabel();
    views.initViews();
    loadReal();
  } catch (e) {
    if (errEl) errEl.textContent = 'Network error';
  }
}

function bindLoginHandlers(){
  const btn = $('btnLogin');
  const passEl = $('pass');
  window.__psaLogin = doLogin;
  if (btn) { btn.addEventListener('click', doLogin); btn.onclick = doLogin; }
  if (passEl) passEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}

function updateCountPill(){
  const pill = $('countPill');
  if (pill) pill.textContent = String(tbl.viewRows.length);
}

async function loadReal(){
  const err = $('subsErr');
  if (err) { err.classList.add('hide'); err.textContent = ''; }

  try {
    const items = await fetchSubmissions(); // fetch all; filter client-side
    tbl.setRows(items.map(tbl.normalizeRow));
    buildServiceOptions();

    views.applyView(views.currentView);
    runFilter();
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

  bindLoginHandlers();

  if (authed) {
    if (loginEl) loginEl.classList.add('hide');
    if (shellEl) shellEl.classList.remove('hide');

    wireUI();
    updateDateButtonLabel();
    views.initViews();
    loadReal();
  } else {
    if (loginEl) loginEl.classList.remove('hide');
    if (shellEl) shellEl.classList.add('hide');
  }
});
