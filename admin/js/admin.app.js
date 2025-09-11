// /admin/js/admin.app.js
import { $, debounce, escapeHtml } from './util.js';
import { fetchSubmissions, logout, fetchSubmissionDetails, fetchGroups, createGroup, addToGroup } from './api.js';
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

  // ── Header checkbox (select all) ────────────────────────────────────────────
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

    const selAllHeader = th0.querySelector('#__selAll');

    // prevent row click handler from firing
    selAllHeader?.addEventListener('click', (e) => e.stopPropagation());

    // select/clear ONLY the currently visible rows
    selAllHeader?.addEventListener('change', () => {
      const rows = getVisibleRows();
      rows.forEach(tr => {
        const id = tr.getAttribute('data-id');
        const cb = tr.querySelector('input.__selrow');
        if (!id || !cb) return;
        cb.checked = selAllHeader.checked;
        if (cb.checked) __selectedSubs.add(id); else __selectedSubs.delete(id);
      });
      updateSelAllUI();
      document.dispatchEvent(new CustomEvent('psa:selection-changed'));
    });
  }

// ── Helpers (re-query tbody each time; table swaps it on render) ───────────
const selAll = thead.querySelector('#__selAll');

const getTbody = () => document.getElementById('subsTbody');

const getVisibleRows = () => {
  const tb = getTbody();
  if (!tb) return [];
  return Array.from(tb.querySelectorAll('tr[data-id]')).filter(tr => {
    const cs = window.getComputedStyle(tr);
    // visible in current page/filter (not display:none/hidden and not .hide)
    return cs.display !== 'none' && cs.visibility !== 'hidden' && !tr.classList.contains('hide');
  });
};

const updateSelAllUI = () => {
  if (!selAll) return;
  const rows = getVisibleRows();
  const total = rows.length;
  const checkedCount = rows.reduce((n, tr) => {
    const cb = tr.querySelector('input.__selrow');
    return n + (cb && cb.checked ? 1 : 0);
  }, 0);
  selAll.indeterminate = checkedCount > 0 && checkedCount < total;
  selAll.checked = total > 0 && checkedCount === total;
};


  // ── Row checkboxes ──────────────────────────────────────────────────────────
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

cb.addEventListener('click', (e) => e.stopPropagation());
cb.addEventListener('change', () => {
  if (cb.checked) __selectedSubs.add(id); else __selectedSubs.delete(id);
  updateSelAllUI();
  document.dispatchEvent(new CustomEvent('psa:selection-changed'));
});
cb.__wiredSel = true; // <- mark as wired to avoid double-binding later

    } else {
      // keep in sync if table re-rendered
      const cb = td0.querySelector('input.__selrow');
      if (cb) {
        cb.checked = __selectedSubs.has(id);
        cb.addEventListener('click', (e) => e.stopPropagation());
        if (!cb.__wiredSel) {
          cb.addEventListener('change', () => {
            if (cb.checked) __selectedSubs.add(id); else __selectedSubs.delete(id);
            updateSelAllUI();
            document.dispatchEvent(new CustomEvent('psa:selection-changed'));
          });
          cb.__wiredSel = true;
        }
      }
    }
  });

  // Initialize header checkbox state for the current page/filter
  updateSelAllUI();
}


function getSelectedSubmissionIds() {
  return Array.from(__selectedSubs);
}

// --- selection helpers for Add-to-group ------------------------------------
function findRowForSubmissionId(sid){
  const key = String(sid || '').toLowerCase();
  // normalize by both "submission_id" and "id" just in case
  for (const r of (tbl.allRows || [])) {
    const k1 = String(r.submission_id || '').toLowerCase();
    const k2 = String(r.id || '').toLowerCase();
    if (k1 === key || k2 === key) return r;
  }
  return null;
}

// Split current selection into "eligible" (not in a group) and "inGroup"
function splitSelectionByEligibility(){
  const ids = getSelectedSubmissionIds();
  const eligible = [];
  const inGroup  = [];

  ids.forEach(id => {
    const row = findRowForSubmissionId(id);
    const grp = (row?.group_code || row?.group || row?.group_id || '').toString().trim();
    if (grp && grp !== '---') inGroup.push({ id, group_code: grp });
    else eligible.push({ id });
  });

  return { eligible, inGroup, total: ids.length };
}

// Given an explicit list of IDs (e.g., pasted), split by eligibility using current table rows.
// Any id not found in the table is treated as eligible.
function eligibleIdsFromList(ids){
  const eligibleIds = [];
  const skipped = [];
  (ids || []).forEach(id => {
    const row = findRowForSubmissionId(id);
    const grp = (row?.group_code || row?.group || row?.group_id || '').toString().trim();
    if (row && grp && grp !== '---') skipped.push({ id, group_code: grp });
    else eligibleIds.push(id);
  });
  return { eligibleIds, skipped };
}

function estimateCardsFromRows(ids){
  let total = 0;
  (ids || []).forEach(id => {
    const r = findRowForSubmissionId(id);
    let c = Number(
      r?.cards ??
      r?.card_count ??
      r?.cards_count ??
      (Array.isArray(r?.items) ? r.items.length : 0) ??
      (Array.isArray(r?.card_info) ? r.card_info.length : 0)
    );
    if (!Number.isFinite(c)) c = 0;
    total += c;
  });
  return total;
}

function extractAddCounts(result, fallbackSubs = 0, idsForFallback = []){
  const addedSubs = Number(
    result?.added_submissions ??
    result?.added?.submissions ??
    result?.submissions_added ??
    result?.submissions ??
    result?.data?.added_submissions ??
    fallbackSubs ?? 0
  );

  let addedCards = Number(
    result?.added_cards ??
    result?.added?.cards ??
    result?.cards_added ??
    result?.cards ??
    result?.data?.added_cards ??
    NaN
  );

  const rc = result || {};
  const explicitCardsProvided =
    ('added_cards' in rc) || ('cards_added' in rc) || ('cards' in rc) ||
    (rc.added && 'cards' in rc.added) ||
    (rc.data && 'added_cards' in rc.data);

  if (!explicitCardsProvided) {
    const est = estimateCardsFromRows(idsForFallback);
    if (Number.isNaN(addedCards) || addedCards === 0) {
      addedCards = est;
    }
  }

  if (!Number.isFinite(addedCards)) addedCards = 0;
  return { addedSubs, addedCards };
}
// ---- tiny helper for alert grammar ----
function plural(n, one, many){ return Number(n) === 1 ? one : many; }

// Update the drawer UI counts & enable/disable buttons.
// Returns the same object as splitSelectionByEligibility().
function updateAddGroupPanelUI(){
  const { eligible, inGroup, total } = splitSelectionByEligibility();

  // Count label (top-right of the drawer)
  const lbl = $('agSelCount') || $('agpSelCount') || $('agp-count');
  if (lbl) lbl.textContent = `${total} selected • ${eligible.length} eligible • ${inGroup.length} already in a group`;

  // Optional skipped list (if you added one)
  const skippedList = $('agp-skipped-list');
  if (skippedList) {
    skippedList.innerHTML = inGroup.length
      ? inGroup.map(x => `<li>${escapeHtml(x.id)} → ${escapeHtml(x.group_code)}</li>`).join('')
      : '<li>None</li>';
  }

  // Buttons: disable when no eligible items
  const btnCreate = $('gp-create-btn') || $('gpCreateBtn') || $('gm-create');
  const btnAdd    = $('gp-add-selected') || $('gpAddSelectedBtn') || $('gp-add-btn') || $('gm-add-existing');
  if (btnCreate) btnCreate.disabled = eligible.length === 0;
  if (btnAdd) btnAdd.disabled = (eligible.length === 0) || !($('gm-manual')?.value?.trim());

  return { eligible, inGroup, total };
}

function showSubmissionsView(){
  setTopbarTitle('Active submissions'); // purely cosmetic on this page
  tbl.renderTable(currentVisibleKeys());
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

// ===================================================================
// Add-to-Group Modal (Create new OR Add to existing)
// ===================================================================
function ensureGroupModalHost(){
  if ($('group-backdrop')) return;

  const back = document.createElement('div');
  back.id = 'group-backdrop';
  back.className = 'details-backdrop';
  back.setAttribute('aria-hidden','true');
  back.innerHTML = `
    <div class="details-panel" role="dialog" aria-modal="true" aria-labelledby="group-title">
      <div class="details-head">
        <div id="group-title" class="sheet-title">Add to group</div>
        <button id="group-close" class="btn" type="button">Close</button>
      </div>
      <div id="group-body" class="details-body"></div>
      <div class="details-foot">
        <div></div>
        <button id="group-cancel" class="btn" type="button">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(back);

  $('group-close')?.addEventListener('click', closeGroupModal);
  $('group-cancel')?.addEventListener('click', closeGroupModal);
  back.addEventListener('mousedown', (e) => {
    const panel = back.querySelector('.details-panel');
    if (panel && !panel.contains(e.target)) closeGroupModal();
  });
  document.addEventListener('keydown', (e) => {
    const b = $('group-backdrop');
    if (!b || !b.classList.contains('show')) return;
    if (e.key === 'Escape') closeGroupModal();
  });
}

function openGroupModal(preselectedIds = []){
  ensureGroupModalHost();
  const back = $('group-backdrop');
  if (!back) return;
  back.classList.add('show');
  back.setAttribute('aria-hidden','false');
  document.body.style.overflow = 'hidden';

  renderGroupModalHome(preselectedIds);

  // initial & live counts based on current selection
  const refreshCounts = () => updateAddGroupPanelUI();
  refreshCounts();
  document.addEventListener('psa:selection-changed', refreshCounts);
  back.__onSelChange = refreshCounts;

}

function closeGroupModal(){
  const back = $('group-backdrop');
  if (!back) return;
  if (back.__onSelChange) {
    document.removeEventListener('psa:selection-changed', back.__onSelChange);
    back.__onSelChange = null;
  }
  back.classList.remove('show');
  back.setAttribute('aria-hidden','true');
  document.body.style.overflow = '';
}

function parseIdsFromInput(s){
  if (!s) return [];
  return s.split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
}

function renderGroupModalHome(preselectedIds){
  const body = $('group-body');
  if (!body) return;

  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <h3 style="margin:0">Choose an action</h3>
      <div style="flex:1"></div>
      <span id="agp-count" class="note"></span>
    </div>

    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">
      <div class="card" style="padding:16px">
        <h4 style="margin:0 0 6px">Create new group</h4>
        <p class="note" style="margin:0 0 12px">Creates a new group (code auto-assigned), then adds submissions.</p>
        <label class="note" for="gm-notes">Notes (optional)</label>
        <input id="gm-notes" type="text" placeholder="Notes" />
        <div style="margin-top:12px">
          <button id="gm-create" class="btn primary">Create & add</button>
        </div>
      </div>

      <div class="card" style="padding:16px">
        <h4 style="margin:0 0 6px">Add to existing</h4>
        <p class="note" style="margin:0 8px 8px 0">Search by code or notes, then pick a group.</p>
        <input id="gm-search" type="text" placeholder="Search groups…" />
        <div id="gm-results" class="table-wrap" style="max-height:240px;overflow:auto;margin-top:8px">
          <table class="data-table" cellspacing="0" cellpadding="0" style="width:100%">
            <thead><tr><th style="width:140px">Code</th><th style="width:120px">Status</th><th style="width:100px">Members</th><th>Notes</th></tr></thead>
            <tbody id="gm-tbody"><tr><td colspan="4" class="note">Type to search…</td></tr></tbody>
          </table>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
          <input id="gm-manual" type="text" placeholder="Or enter code (e.g., GRP-0002)" style="flex:1">
          <button id="gm-add-existing" class="btn" disabled>Add to selected</button>
        </div>
      </div>
    </div>

    ${
      preselectedIds.length
        ? ''
        : `
          <div class="card" style="padding:12px;margin-top:12px">
            <div class="note" style="margin-bottom:6px">No rows selected — paste submission IDs (comma/space/newline separated):</div>
            <textarea id="gm-ids" rows="2" placeholder="psa-111, psa-161 …" style="width:100%"></textarea>
          </div>
        `
    }
  `;

  // ===== Create new group (guard against empty/invalid selection) =====
  $('gm-create')?.addEventListener('click', async () => {
    const notes = $('gm-notes')?.value?.trim() || null;

    let ids = preselectedIds.slice();
    let eligibleIds = [];

    if (ids.length) {
      // Use only eligible from current selection
      const { eligible } = splitSelectionByEligibility();
      eligibleIds = eligible.map(x => x.id);
    } else {
      // No selection: use pasted list, then compute eligibility from current table rows
      ids = parseIdsFromInput($('gm-ids')?.value || '');
      if (!ids.length) return alert('Please select rows or paste submission IDs.');
      const r = eligibleIdsFromList(ids);
      eligibleIds = r.eligibleIds;
      if (r.skipped.length) {
        // purely informational, still proceed with any eligible
        console.warn('Skipped already-in-group:', r.skipped);
      }
    }

    if (!eligibleIds.length) {
      alert('All chosen submissions are already attached to a group. No group was created.');
      return; // ❌ never create empty groups
    }

    try {
      const group = await createGroup({ notes }); // server assigns code, Draft by default
      const result = await addToGroup(group.code, eligibleIds);
      const { addedSubs, addedCards } = extractAddCounts(result, eligibleIds.length, eligibleIds);
      alert(`Created ${group.code}\nAdded ${addedSubs} ${plural(addedSubs,'submission','submissions')} and ${addedCards} ${plural(addedCards,'card','cards')}.`);
      closeGroupModal();
      loadReal?.();
    } catch (e) {
      alert(`Create/Add failed: ${e.message}`);
    }
  });

// ===== Add to existing (guard; add only eligible) =====
const btnAdd = $('gm-add-existing');
let chosenCode = '';

const applyChosen = async () => {
  if (!chosenCode) return;

  // 🔎 If we can find this group, block when not Draft/ReadyToShip
  try {
    const resp = await fetchGroups({ q: chosenCode, limit: 25, offset: 0 });
    const items = Array.isArray(resp?.items) ? resp.items : [];
    const match = items.find(g => String(g.code || '').toUpperCase() === chosenCode.toUpperCase());
    if (match) {
      const st = String(match.status || '').toLowerCase().replace(/\s+/g, '');
      const isOpen = (st === 'draft' || st === 'readytoship');
      if (!isOpen) {
        alert(`You can’t add to ${match.code} because its status is “${match.status}”.`);
        return;
      }
    }
  } catch {
    // If search fails, we’ll fall back to the server guard in Step 2.
  }

  // Build the eligible ID list exactly as before
  let ids = preselectedIds.slice();
  let eligibleIds = [];

  if (ids.length) {
    const { eligible } = splitSelectionByEligibility();
    eligibleIds = eligible.map(x => x.id);
  } else {
    ids = parseIdsFromInput($('gm-ids')?.value || '');
    if (!ids.length) return alert('Please select rows or paste submission IDs.');
    const r = eligibleIdsFromList(ids);
    eligibleIds = r.eligibleIds;
  }

  if (!eligibleIds.length) {
    alert('All chosen submissions are already attached to a group.');
    return;
  }

  try {
    const result = await addToGroup(chosenCode, eligibleIds);
    const { addedSubs, addedCards } = extractAddCounts(result, eligibleIds.length, eligibleIds);
    alert(`Added ${addedSubs} ${plural(addedSubs,'submission','submissions')} and ${addedCards} ${plural(addedCards,'card','cards')} to ${chosenCode}.`);
    closeGroupModal();
    loadReal?.();
  } catch (e) {
    alert(`Add failed: ${e.message}`);
  }
};


  $('gm-add-existing')?.addEventListener('click', applyChosen);
  $('gm-manual')?.addEventListener('input', (e) => {
    chosenCode = e.target.value.trim().toUpperCase();
    if (btnAdd) btnAdd.disabled = !chosenCode;
  });

  $('gm-manual')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && chosenCode) {
    e.preventDefault();
    applyChosen();
  }
});

const renderRows = (items = [], { heading = null } = {}) => {
  const tb = $('gm-tbody'); if (!tb) return;

  if (!items.length) {
    tb.innerHTML = `<tr><td colspan="4" class="note">${heading || 'No results.'}</td></tr>`;
    return;
  }

const rowsHtml = items.map(r => {
  const id   = String(r.id ?? '').trim();
  const code = escapeHtml(r.code || '');
  const statusRaw = String(r.status || '');
  const status = escapeHtml(statusRaw);
  const notes  = escapeHtml(r.notes  || '');
  const cnt = Number(r.submission_count ?? r.members ?? r.member_count ?? 0);

  // Only Draft/ReadyToShip are “open” for adding
  const s = statusRaw.toLowerCase().replace(/\s+/g, '');
  const isOpen = (s === 'draft' || s === 'readytoship');

  const cls = isOpen ? 'gm-row selectable' : 'gm-row disabled';
  const title = isOpen
    ? `Use ${code}`
    : `Cannot add to ${code} (status: ${statusRaw})`;

  return `
    <tr class="${cls}"
        data-id="${escapeHtml(id)}"
        data-code="${code}"
        title="${escapeHtml(title)}">
      <td><strong>${code}</strong></td>
      <td>${status}</td>
      <td>${cnt}</td>
      <td>${notes}</td>
    </tr>
  `;
}).join('');


  tb.innerHTML = (heading ? `<tr><td colspan="4" class="note">${escapeHtml(heading)}</td></tr>` : '') + rowsHtml;

tb.querySelectorAll('tr.gm-row').forEach(tr => {
  const isDisabled = tr.classList.contains('disabled');

  tr.addEventListener('click', () => {
    if (isDisabled) return; // 🚫 ignore disabled rows
    tb.querySelectorAll('tr.gm-row.selected').forEach(x => x.classList.remove('selected'));
    tr.classList.add('selected');
    chosenCode = tr.getAttribute('data-code') || '';
    if ($('gm-manual')) $('gm-manual').value = chosenCode;
    if (btnAdd) btnAdd.disabled = !chosenCode;
  });

  tr.addEventListener('dblclick', () => {
    if (isDisabled) return; // 🚫 ignore disabled rows
    // select then apply
    tr.click();
    applyChosen();
  });
});

};


  const doSearch = async (term) => {
    const tb = $('gm-tbody');
    if (tb) tb.innerHTML = `<tr><td colspan="4" class="note">Searching…</td></tr>`;
    try {
      const resp = await fetchGroups({ q: term, limit: 50, offset: 0 });
      const items = Array.isArray(resp?.items) ? resp.items : [];
      renderRows(items);
    } catch {
      if (tb) tb.innerHTML = `<tr><td colspan="4" class="note">Search failed.</td></tr>`;
    }
  };

  // <<< MOVED HERE — needs access to renderRows >>>
  const loadRecent = async () => {
    const tb = $('gm-tbody');
    if (tb) tb.innerHTML = `<tr><td colspan="4" class="note">Loading recent…</td></tr>`;

    // tiny helpers for sorting by recency with fallbacks
    const toMs = v => { const t = Date.parse(v || ''); return Number.isNaN(t) ? null : t; };
    const codeNum = v => { const n = Number(String(v||'').replace(/\D/g,'')); return Number.isNaN(n) ? -Infinity : n; };

    try {
      const resp = await fetchGroups({ limit: 200, offset: 0 });
      let items = Array.isArray(resp?.items) ? resp.items : [];

      // newest first; fallback to numeric part of code
      items = items.sort((a,b) => {
        const ba = toMs(b.created_at || b.inserted_at || b.updated_at);
        const aa = toMs(a.created_at || a.inserted_at || a.updated_at);
        if (ba !== aa) return (ba || -Infinity) - (aa || -Infinity);
        return codeNum(b.code) - codeNum(a.code);
      }).slice(0,5);

      renderRows(items, { heading: 'Recent (last 5)' });
    } catch {
      if (tb) tb.innerHTML = `<tr><td colspan="4" class="note">Failed to load recent.</td></tr>`;
    }
  };
  // <<< END moved block >>>

  const debSearch = debounce(() => {
    const term = $('gm-search')?.value?.trim() || '';
    if (!term) { loadRecent(); return; }
    doSearch(term);
  }, 250);

  $('gm-search')?.addEventListener('input', debSearch);
  loadRecent(); // show last 5 groups by default
}

// --- helpers for rendering ---
function renderAddress(r) {
  // 1) Direct string or array (use immediately)
  const direct = [r.ship_to, r.shipping_address, r.shopify_shipping_address, r.ship_address, r.address]
    .find(v => typeof v === 'string' && v.trim());
  if (direct) return `<address class="shipto">${escapeHtml(direct)}</address>`;

  const directArr = [r.ship_to, r.shipping_address, r.shopify_shipping_address, r.ship_address, r.address]
    .find(v => Array.isArray(v) && v.length && v.some(s => String(s).trim()));
  if (directArr) {
    return `<address class="shipto">${directArr.map(s => escapeHtml(String(s))).join('<br>')}</address>`;
  }

  // 2) Look for a nested object in common places
  const nested =
    ['shipping_address','shopify_shipping_address','ship_address','address','shipping','shippingAddress']
      .map(k => r?.[k])
      .find(v => v && typeof v === 'object' && !Array.isArray(v)) || null;

  const pick = (...vals) => {
    for (const v of vals) if (v != null && String(v).trim() !== '') return String(v).trim();
    return '';
  };

  // generic key finder as a last-resort (handles weird key names)
  const findKey = (obj, rx) => {
    if (!obj) return '';
    for (const [k, v] of Object.entries(obj)) {
      if (rx.test(k) && v != null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };

  const name = pick(
    r.ship_name, r.shipping_name, r.ship_to_name,
    r.customer_name, r.name,
    nested?.name,
    (nested?.first_name && nested?.last_name) ? `${nested.first_name} ${nested.last_name}` : '',
    nested?.recipient, nested?.full_name, nested?.contact_name,
    findKey(nested, /name|recipient|contact/i)
  );

  const a1 = pick(
    r.ship_addr1, r.ship_address1, r.address1,
    nested?.address1, nested?.address_line1, nested?.line1, nested?.addr1,
    nested?.street1, nested?.street_address1, nested?.street,
    findKey(nested, /address.?1|line.?1|addr1|street(_address)?1?|address_1/i)
  );

  const a2Raw = pick(
    r.ship_addr2, r.ship_address2, r.address2,
    nested?.address2, nested?.address_line2, nested?.line2,
    nested?.street2, nested?.unit, nested?.apt, nested?.apartment, nested?.suite,
    findKey(nested, /address.?2|line.?2|addr2|street2|suite|unit|apt|apartment|address_2/i)
  );
  const a2 = a2Raw && /^[0-9A-Za-z\-]+$/.test(a2Raw) && (nested?.suite || /suite|unit|apt|apartment/i.test(a2Raw) === false)
    ? `Suite ${a2Raw}` : a2Raw;

  const city    = pick(r.ship_city,  r.city,  nested?.city,  nested?.town, nested?.locality, findKey(nested, /city|town|locality/i));
  const state   = pick(r.ship_state, r.state, nested?.state, nested?.region, nested?.province, nested?.state_code, nested?.province_code, findKey(nested, /state|region|prov/i));
  const zip     = pick(r.ship_zip,   r.zip,   nested?.zip,   nested?.zip_code, nested?.postal, nested?.postal_code, nested?.postalCode, findKey(nested, /(postal|zip)/i));
  const country = pick(r.ship_country, r.country, nested?.country, nested?.country_code, nested?.countryCode, findKey(nested, /country/i));

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
    const r = await fetchSubmissionDetails(id);
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
  }); // bubble phase

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

async function loadReal(){
  const err = $('subsErr');
  if (err) { err.classList.add('hide'); err.textContent = ''; }

  try {
    let items = await fetchSubmissions(); // fetch all; filter client-side

    tbl.setRows(items.map(tbl.normalizeRow));
    buildServiceOptions();

    views.applyView?.(views.currentView);
    runFilter();
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

  // Add-to-group button -> open modal
  try {
    const toolbar = document.querySelector('#view-submissions .toolbar');
    if (toolbar && !document.getElementById('btnAddToGroup')) {
      const b = document.createElement('button');
      b.id = 'btnAddToGroup';
      b.className = 'btn primary';
      b.type = 'button';
      b.textContent = 'Add to group…';
      b.style.marginLeft = '8px';
      b.addEventListener('click', () => {
        const selected = getSelectedSubmissionIds();
        openGroupModal(selected);
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

window.addEventListener('psa:table-rendered', ensureSelectionColumn);

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
