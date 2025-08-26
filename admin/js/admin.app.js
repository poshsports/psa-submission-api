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
// ----- Status popover helpers -----
function getCheckedStatuses() {
  return Array.from(
    document.querySelectorAll('#status-popover input[type="checkbox"][data-status]:checked')
  ).map(el => el.getAttribute('data-status'));
}

function updateStatusButtonLabel() {
  const btn = $('btnStatus'); if (!btn) return;
  const vals = getCheckedStatuses();
  btn.textContent = vals.length ? `Status: ${vals.join(', ')}` : 'Status: All';
}

function openStatusPopover() {
  const pop = $('status-popover'); const btn = $('btnStatus');
  if (!pop || !btn) return;
  if (!pop.classList.contains('hide')) { closeStatusPopover(); return; }

  pop.classList.remove('hide');
  positionPopover(pop, btn);

  const onDoc = (e) => { if (!pop.contains(e.target) && e.target !== btn) closeStatusPopover(); };
  const onEsc = (e) => { if (e.key === 'Escape') closeStatusPopover(); };
  pop.__off = () => {
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onEsc, true);
  };
  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onEsc, true);
}

function closeStatusPopover() {
  const pop = $('status-popover'); if (!pop) return;
  pop.classList.add('hide'); pop.__off?.(); pop.__off = null;
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
  document
    .querySelectorAll('#status-popover input[type="checkbox"][data-status]')
    .forEach(cb => (cb.checked = false));
  updateStatusButtonLabel();
  const e = $('fEval');    if (e) e.value = 'all';
  const g = $('fService'); if (g) g.value = '';

  const from = $('dateFrom'), to = $('dateTo');
  if (from) from.value = '';
  if (to)   to.value   = '';
  selStart = selEnd = hoverDay = null;

  updateDateButtonLabel();
  runFilter();
}

function setTopbarTitle(text){
  const el = document.querySelector('.topbar .brand strong');
  if (el) el.textContent = text;
}

function currentVisibleKeys(){
  const ths = Array.from(document.querySelectorAll('#subsHead th[data-key]'))
    .filter(th => th.style.display !== 'none');
  return ths.map(th => th.dataset.key);
}

// ===== simple selection (checkboxes) =====
const __selectedSubs = new Set();
window.__selectedSubs = __selectedSubs; // dev peek

function ensureSelectionColumn() {
  const thead = document.getElementById('subsHead');
  const tbody = document.getElementById('subsTbody');
  if (!thead || !tbody) return;

  // Header checkbox (select all)
  let th0 = thead.querySelector('th.__selcol');
  if (!th0) {
    th0 = document.createElement('th');
    th0.className = '__selcol';
    th0.style.width = '36px';
    th0.style.textAlign = 'center';
    th0.innerHTML = `<input id="__selAll" type="checkbox" aria-label="Select all">`;

    const firstTh = thead.querySelector('th');
    if (firstTh) firstTh.parentNode.insertBefore(th0, firstTh);
    else thead.appendChild(th0);

    const selAll = th0.querySelector('#__selAll');

    // 👍 prevent row click handler from firing
    selAll?.addEventListener('click', (e) => e.stopPropagation());

    selAll?.addEventListener('change', () => {
      const rows = tbody.querySelectorAll('tr[data-id]');
      rows.forEach(tr => {
        const id = tr.getAttribute('data-id');
        const cb = tr.querySelector('input.__selrow');
        if (!id || !cb) return;
        cb.checked = selAll.checked;
        if (cb.checked) __selectedSubs.add(id); else __selectedSubs.delete(id);
      });
    });
  }

  // Row checkboxes
  const rows = Array.from(tbody.querySelectorAll('tr[data-id]'));
  rows.forEach(tr => {
    const id = tr.getAttribute('data-id');
    if (!id) return;

    let td0 = tr.querySelector('td.__selcol');
    if (!td0) {
      td0 = document.createElement('td');
      td0.className = '__selcol';
      td0.style.textAlign = 'center';
      td0.innerHTML = `<input type="checkbox" class="__selrow" aria-label="Select row">`;
      const firstTd = tr.querySelector('td');
      if (firstTd) tr.insertBefore(td0, firstTd); else tr.appendChild(td0);

      const cb = td0.querySelector('input.__selrow');
      cb.checked = __selectedSubs.has(id);

      // 👍 prevent row click handler from firing
      cb.addEventListener('click', (e) => e.stopPropagation());

      cb.addEventListener('change', () => {
        if (cb.checked) __selectedSubs.add(id); else __selectedSubs.delete(id);
      });
    } else {
      // keep in sync if table re-rendered
      const cb = td0.querySelector('input.__selrow');
      if (cb) {
        cb.checked = __selectedSubs.has(id);
        // 👍 ensure existing boxes also stop bubbling
        cb.addEventListener('click', (e) => e.stopPropagation());
      }
    }
  });
}


function getSelectedSubmissionIds() {
  return Array.from(__selectedSubs);
}

function showSubmissionsView(){
  setTopbarTitle('Active submissions'); // purely cosmetic on this page
  tbl.renderTable(currentVisibleKeys());
  // after each render, ensure selection column exists
  setTimeout(ensureSelectionColumn, 0);
}

// ===== Submission details drawer =====
function ensureDetailsHost() {
  if ($('details-backdrop')) return;

  const back = document.createElement('div');
  back.id = 'details-backdrop';
  back.className = 'details-backdrop';
  back.setAttribute('aria-hidden','true');
  back.innerHTML = `
    <div class="details-panel" role="dialog" aria-modal="true" aria-labelledby="details-title">
      <div class="details-head">
        <div id="details-title" class="sheet-title">Submission</div>
        <button id="details-close" class="btn" type="button">Close</button>
      </div>
      <div id="details-body" class="details-body">
        <div class="loading">Loading…</div>
      </div>
      <div class="details-foot">
        <div></div>
        <button id="details-close-2" class="btn" type="button">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(back);
}

function ensureDetailsBackdropWired() {
  const back = $('details-backdrop');
  if (!back || back.__wired) return;
  back.__wired = true;

  const panel = back.querySelector('.details-panel');

  $('details-close')?.addEventListener('click', closeSubmissionDetails);
  $('details-close-2')?.addEventListener('click', closeSubmissionDetails);

  back.addEventListener('mousedown', (e) => {
    if (!panel.contains(e.target)) closeSubmissionDetails();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSubmissionDetails();
  });
}

function openSubmissionDetailsPanel() {
  ensureDetailsHost();
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
function renderAddress(r) {
  // If backend gives a single formatted string, use it.
  if (typeof r.ship_to === 'string' && r.ship_to.trim()) {
    return `<address class="shipto">${escapeHtml(r.ship_to)}</address>`;
  }

  // Common nested containers we see in different sources
  const nested =
    r.shipping_address ||
    r.shopify_shipping_address ||
    r.ship_address ||
    r.address ||
    r.shipping ||
    r.shippingAddress ||
    null;

  const pick = (...vals) => {
    for (const v of vals) if (v != null && String(v).trim() !== '') return String(v).trim();
    return '';
  };

  // ---- NAME ----
  const name = pick(
    r.ship_name, r.shipping_name, r.ship_to_name,
    r.customer_name, r.name,
    nested?.name,
    (nested?.first_name && nested?.last_name) ? `${nested.first_name} ${nested.last_name}` : '',
    nested?.recipient, nested?.full_name, nested?.contact_name
  );

  // ---- ADDRESS LINES ----
  const a1 = pick(
    r.ship_addr1, r.ship_address1, r.address1,
    nested?.address1, nested?.line1, nested?.addr1, nested?.street1, nested?.street_address1,
    nested?.street
  );

  const a2Raw = pick(
    r.ship_addr2, r.ship_address2, r.address2,
    nested?.address2, nested?.line2,
    nested?.street2, nested?.address_line2, nested?.address_line_2,
    nested?.unit, nested?.apt, nested?.apartment, nested?.suite
  );
  const a2 = a2Raw && /^[0-9A-Za-z\-]+$/.test(a2Raw) && (nested?.suite || /suite|unit|apt|apartment/i.test(a2Raw) === false)
    ? `Suite ${a2Raw}` : a2Raw;

  const city    = pick(r.ship_city,  r.city,  nested?.city,  nested?.town, nested?.locality);
  const state   = pick(r.ship_state, r.state, nested?.state, nested?.region, nested?.province, nested?.state_code, nested?.province_code);
  const zip     = pick(r.ship_zip,   r.zip,   nested?.zip,   nested?.postal_code, nested?.postal);
  const country = pick(r.ship_country, r.country, nested?.country, nested?.country_code);

  const parts = [name, a1, a2, [city, state, zip].filter(Boolean).join(', '), country].filter(Boolean);
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
        <div>${escapeHtml(String(num || ''))}</div>
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

function fmtMoney(n){ return `$${(Number(n)||0).toLocaleString()}`; }
function fmtDate(iso){
  try { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString(); }
  catch { return ''; }
}

async function openSubmissionDetails(id) {
  openSubmissionDetailsPanel();

  const titleEl = $('details-title');
  const bodyEl  = $('details-body');

  // provisional title while loading
  if (titleEl) {
    titleEl.innerHTML = `Submission <strong>${escapeHtml(String(id).toUpperCase())}</strong>`;
  }
  if (bodyEl) bodyEl.innerHTML = `<div class="loading">Loading…</div>`;

  try {
    const r = await fetchSubmission(id);
    if (titleEl) {
      const titleId = String(r?.submission_id || r?.id || id).toUpperCase();
      titleEl.innerHTML = `Submission <strong>${escapeHtml(titleId)}</strong>`;
    }
    const evalAmtNum = Number(
      (r.evaluation ?? 0) || (r.eval_line_sub ?? 0) || (r?.totals?.evaluation ?? 0)
    ) || 0;
    const evalYesNo  = evalAmtNum > 0 ? 'Yes' : 'No';

    const grand   = r?.totals?.grand ?? r.grand_total ?? r.total ?? r.grand ?? 0;
    const paidAmt = r.paid_amount || 0;
    const cards   = r.card_info || r.cards || r.items || [];
    const email   = r.customer_email || r.email || '';
    const shipHTML = renderAddress(r);

    // ---- INFO GRID (card-style) ----
    const infoGrid = `
      <div class="info-grid">
        <div class="info">
          <div class="info-label">Submission</div>
          <div class="info-value"><code>${escapeHtml(String(r.submission_id || r.id || id))}</code></div>
        </div>

        <div class="info">
          <div class="info-label">Status</div>
          <div class="info-value"><span class="pill">${escapeHtml(String(r.status || '')) || '—'}</span></div>
        </div>

        <div class="info">
          <div class="info-label">Cards</div>
          <div class="info-value">${escapeHtml(String(r.cards ?? (Array.isArray(cards) ? cards.length : 0)))}</div>
        </div>

        <div class="info">
          <div class="info-label">Evaluation</div>
          <div class="info-value">${evalYesNo}</div>
        </div>

        <div class="info">
          <div class="info-label">Grand</div>
          <div class="info-value">${escapeHtml(fmtMoney(grand))}</div>
        </div>

        <div class="info">
          <div class="info-label">Paid</div>
          <div class="info-value">${escapeHtml(fmtMoney(paidAmt))}</div>
        </div>

        <div class="info span-2">
          <div class="info-label">Grading Service</div>
          <div class="info-value ellip">${escapeHtml(String(r.grading_service || r.grading_services || r.service || r.grading || '')) || '—'}</div>
        </div>

        <div class="info">
          <div class="info-label">Created</div>
          <div class="info-value">${escapeHtml(fmtDate(r.created_at || r.inserted_at || r.submitted_at_iso || r.submitted_at))}</div>
        </div>

        <div class="info">
          <div class="info-label">Order</div>
          <div class="info-value">${r.shopify_order_name ? `<span class="pill">${escapeHtml(r.shopify_order_name)}</span>` : '—'}</div>
        </div>

        <div class="info span-2">
          <div class="info-label">Email</div>
          <div class="info-value">${email ? `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : '—'}</div>
        </div>

        <div class="info span-2">
          <div class="info-label">Ship-to</div>
          <div class="info-value">${shipHTML || '—'}</div>
        </div>
      </div>
    `;

    const cardsHTML = renderCardsTable(cards);
    const jsonHTML = `
      <details style="margin-top:12px">
        <summary>Raw JSON</summary>
        <pre class="json">${escapeHtml(JSON.stringify(r, null, 2))}</pre>
      </details>
    `;

    if (bodyEl) bodyEl.innerHTML = infoGrid + cardsHTML + jsonHTML;
  } catch (e) {
    if (bodyEl) bodyEl.innerHTML = `<div class="error">Failed to load details: ${escapeHtml(e.message || 'Error')}</div>`;
  }
}

// Allow other modules / inline HTML to open the sheet.
window.__openAdminDetails = (id, friendly) => openSubmissionDetails(id || friendly || '');

// ===== row click delegation (submissions table) =====
function wireRowClickDelegation(){
  const tb = $('subsTbody');
  if (!tb || tb.__wiredRowClick) return;
  tb.__wiredRowClick = true;

  tb.addEventListener('click', (e) => {
  // Ignore clicks that originate in the selection column or on checkboxes
  if (e.target?.closest?.('td.__selcol')) return;
  if (e.target?.matches?.('input.__selrow, #__selAll')) return;

  const tr = e.target?.closest?.('tr[data-id]');
  if (!tr) return;
  const id = tr.dataset.id;
  if (!id) return;

  // ignore plain link clicks (they’re non-nav here anyway)
  const a = e.target.closest?.('a');
  if (a) { e.preventDefault(); e.stopPropagation(); }

  openSubmissionDetails(id);
}); // <-- bubble phase (no ", true")

tb.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  // If focus is in the selection column, don't open details
  if (e.target?.closest?.('td.__selcol')) return;

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

// ===== auth & boot (Submissions page only) =====
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

    bootSubmissionsUI();
  } catch (e) {
    if (errEl) errEl.textContent = 'Network error';
  }
}

function bootSubmissionsUI(){
  wireUI();
  updateDateButtonLabel();
  updateStatusButtonLabel();
  views.initViews?.();
  showSubmissionsView();
  loadReal();
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

// Try to find a "GRP-xxxx" style code anywhere in the detail payload.
function findGroupCodeDeep(obj) {
  const seen = new Set();
  const stack = [obj];
  const re = /^GRP-[A-Za-z0-9_-]+$/; // adjust if your codes look different

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    // explicit/common shapes first
    if (typeof cur.group_code === 'string' && re.test(cur.group_code)) return cur.group_code;
    if (cur.group && typeof cur.group === 'string' && re.test(cur.group)) return cur.group;
    if (cur.group && typeof cur.group.code === 'string' && re.test(cur.group.code)) return cur.group.code;

    // generic deep scan
    for (const k of Object.keys(cur)) {
      const v = cur[k];
      if (typeof v === 'string' && re.test(v)) return v;
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

async function hydrateGroupCodes(items){
  const out = [];
  for (const s of items) {
    // If the list item already has a group, keep it.
    if (s.group_code || (s.group && (s.group.code || typeof s.group === 'string'))) {
      out.push(s);
      continue;
    }
    try {
      const id = s.submission_id || s.id;
      const full = await fetchSubmission(id);

      // Try explicit fields, then fallback to deep scan
      const gc =
        full.group_code ??
        full.group?.code ??
        (typeof full.group === 'string' ? full.group : null) ??
        findGroupCodeDeep(full) ??
        null;

      if (gc) s.group_code = gc;     // attach so normalizeRow can show it
    } catch (_) {
      // ignore; will show ---
    }
    out.push(s);
  }
  return out;
}

async function loadReal(){
  const err = $('subsErr');
  if (err) { err.classList.add('hide'); err.textContent = ''; }

  try {
    let items = await fetchSubmissions(); // fetch all; filter client-side
    // DEBUG: peek at group fields coming from the API
if (Array.isArray(items) && items.length) {
  const probe = items.slice(0, 5).map(s => ({
    id: s.submission_id || s.id,
    // what the backend might call it:
    group_code: s.group_code ?? s.group?.code ?? s.group ?? null,
    // keep raw keys to eyeball quickly
    has_group_code_key: Object.prototype.hasOwnProperty.call(s, 'group_code'),
    has_group_key: Object.prototype.hasOwnProperty.call(s, 'group'),
  }));
  console.table(probe);
}
    items = await hydrateGroupCodes(items);
    tbl.setRows(items.map(tbl.normalizeRow));
    buildServiceOptions();

    views.applyView?.(views.currentView);
    runFilter();
    setTimeout(ensureSelectionColumn, 0);
  } catch (e) {
    if (err) { err.textContent = e.message || 'Load failed'; err.classList.remove('hide'); }
    console.error('[admin] loadReal error:', e);
  }
}

// ===== UI wiring (Submissions page) =====
function wireUI(){
  ensureSignoutWired();
  updateStatusButtonLabel(); // show "Status: All" on first paint

  // Sidebar nav -> use real page navigation
  $('nav-active')?.addEventListener('click', (e) => {
    e.preventDefault();
    // You are already on the Submissions app, but keep this explicit & future-proof:
    window.location.assign('/admin/index.html');
  });

  // IMPORTANT: navigate to the dedicated Groups page
  $('nav-groups')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.location.assign('/admin/groups.html');
  });

  $('btnRefresh')?.addEventListener('click', loadReal);
  $('btnResetFilters')?.addEventListener('click', resetFilters);
  $('btnStatus')?.addEventListener('click', openStatusPopover);
  $('statusApply')?.addEventListener('click', () => {
    closeStatusPopover();
    updateStatusButtonLabel();
    runFilter();
  });
  $('statusClear')?.addEventListener('click', () => {
    document
      .querySelectorAll('#status-popover input[type="checkbox"][data-status]')
      .forEach(cb => (cb.checked = false));
    updateStatusButtonLabel();
  });

  const debouncedFilter = debounce(runFilter, 150);
  $('q')?.addEventListener('input', debouncedFilter);
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
    setTimeout(ensureSelectionColumn, 0);
  });
  $('next-page')?.addEventListener('click', () => {
    tbl.nextPage();
    tbl.renderTable(currentVisibleKeys());
    updateCountPill();
    setTimeout(ensureSelectionColumn, 0);
  });

  $('btnColumns')?.addEventListener('click', views.openColumnsPanel);
  $('close-columns')?.addEventListener('click', views.closeColumnsPanel);
  $('columns-cancel')?.addEventListener('click', views.closeColumnsPanel);
  $('columns-save')?.addEventListener('click', views.saveColumnsPanel);

   wireRowClickDelegation();

  // === TEMP: Add-to-group button (dev helper) ===
  try {
    const toolbar = document.querySelector('#view-submissions .toolbar');
    if (toolbar && !document.getElementById('btnAddToGroup')) {
      const b = document.createElement('button');
      b.id = 'btnAddToGroup';
      b.className = 'btn primary';
      b.type = 'button';
      b.textContent = 'Add to group…';
      b.style.marginLeft = '8px';
b.addEventListener('click', async () => {
  try {
    const preselected = getSelectedSubmissionIds();
    const choice = prompt(
      preselected.length
        ? `Type "new" to create a group,\nOR enter an existing group code/UUID (selected: ${preselected.join(', ')})`
        : 'Type "new" to create a group,\nOR enter an existing group code/UUID (e.g., GRP-0002):'
    );
    if (!choice) return;

    const { addToGroup, createGroup } = await import('./api.js');

    let groupCode = null;
    if (choice.trim().toLowerCase() === 'new') {
      const notes = prompt('Notes for the new group? (optional)') || null;
      const group = await createGroup({ notes }); // status defaults to Draft
      groupCode = group.code;
      alert(`Created group ${groupCode}`);
    } else {
      groupCode = choice.trim();
    }

    // Use selected submissions if any; else prompt for CSV
    let submissionIds = preselected;
    if (!submissionIds.length) {
      const csv = prompt('Submission IDs (comma-separated, e.g., psa-111, psa-161):');
      if (!csv) return;
      submissionIds = csv.split(',').map(s => s.trim()).filter(Boolean);
    }

    const result = await addToGroup(groupCode, submissionIds);
    alert(`Added ${result.added_submissions} submissions and ${result.added_cards} cards to ${groupCode}`);
  } catch (e) {
    alert(`Add failed: ${e.message}`);
  }
});
      toolbar.appendChild(b);
    }
  } catch {}
}

// Fallback delegation
document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'q') runFilter();
}, true);
document.addEventListener('change', (e) => {
  const id = e.target && e.target.id;
  if (id === 'fEval' || id === 'fService') runFilter();
  if (e.target && e.target.matches('#status-popover input[type="checkbox"][data-status]')) {
    // if you want immediate filtering on check/uncheck, uncomment next line:
    // runFilter();
  }
}, true);
document.addEventListener('click', (e) => {
  const t = e.target && e.target.closest && e.target.closest('#sidebar-signout');
  if (t) doLogout(e);
});

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
    bootSubmissionsUI();
  } else {
    if (loginEl) loginEl.classList.remove('hide');
    if (shellEl) shellEl.classList.add('hide');
  }
});
