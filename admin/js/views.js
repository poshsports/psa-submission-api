// /admin/js/views.js
import { $ } from './util.js';
import { COLUMNS, defaultOrder, defaultHidden } from './columns.js';
import * as tbl from './table.js';

const LS_VIEWS = 'psa_admin_table_views_v1';
const LS_CUR   = 'psa_admin_current_view';

export let currentView = 'Default';

/* ---------- storage helpers ---------- */
function readViews(){
  try { return JSON.parse(localStorage.getItem(LS_VIEWS) || '{}'); }
  catch { return {}; }
}
function writeViews(v){ localStorage.setItem(LS_VIEWS, JSON.stringify(v)); }
function getCur(){ return localStorage.getItem(LS_CUR) || 'Default'; }
function setCur(n){ localStorage.setItem(LS_CUR, n); }

/* Custom 2-button confirm: returns 'overwrite' | 'saveas' | null */
function confirmOverwriteOrSaveAs(viewName){
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal';

    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    panel.style.maxWidth = '420px';

    const h = document.createElement('h3');
    h.textContent = 'Save changes?';

    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `Update “${viewName}” or save a new view.`;

    const footer = document.createElement('div');
    footer.className = 'row';
    footer.style.justifyContent = 'flex-end';
    footer.style.gap = '8px';

    const btnSaveAs = document.createElement('button');
    btnSaveAs.className = 'btn';
    btnSaveAs.textContent = 'Save New';

    const btnOverwrite = document.createElement('button');
    btnOverwrite.className = 'btn primary';
    btnOverwrite.textContent = 'Overwrite';

    btnSaveAs.onclick = () => cleanup('saveas');
    btnOverwrite.onclick = () => cleanup('overwrite');
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(null); };

    footer.append(btnSaveAs, btnOverwrite);
    panel.append(h, p, footer);
    overlay.append(panel);
    document.body.append(overlay);

    function cleanup(result){
      overlay.remove();
      resolve(result);
    }
  });
}

/* Capture current UI state (order/hidden + sort) WITHOUT persisting */
function captureState(){
  const { order, hidden } = currentHeaderState();
  const { sortKey, sortDir } = tbl.getSort();
  return { order, hidden, sortKey, sortDir };
}

/* ---------- public API ---------- */
export function initViews(){
  const all = readViews();
  const { sortKey, sortDir } = tbl.getSort();

  // Seed default view on first run
  if (!all['Default']) {
    all['Default'] = { order: defaultOrder, hidden: defaultHidden, sortKey, sortDir };
    writeViews(all);
  }

  currentView = getCur();
  if (!all[currentView]) currentView = 'Default';

  applyView(currentView);
  renderViewsBar();
}

export function applyView(name){
  const all = readViews();
  const v = all[name] || all['Default'];
  if (!v) return;

  // Merge with current columns (survive future additions/removals)
  const known = new Set(COLUMNS.map(c => c.key));
  let order = (v.order || defaultOrder).filter(k => known.has(k));
  const missing = COLUMNS.map(c => c.key).filter(k => !order.includes(k));
  order = order.concat(missing);
  const hidden = (v.hidden || defaultHidden).filter(k => known.has(k));

  // Sort
  tbl.setSort(v.sortKey || 'created_at', v.sortDir || 'desc');

  // Paint header + render rows
  tbl.renderHead(order, hidden);
  tbl.applyFilters();
}

/* ---------- top views bar ---------- */
export function renderViewsBar(){
  const bar = $('views-bar');
  if (!bar) return;

  bar.innerHTML = '';

  const all = readViews();

  // Left side: saved view pills
  const left = document.createElement('div');
  left.style.display = 'flex';
  left.style.alignItems = 'center';
  left.style.gap = '8px';

  Object.keys(all).forEach(name => {
    const pill = document.createElement('button');
    pill.className = 'view-pill' + (name === currentView ? ' active' : '');
    pill.textContent = name;
    pill.onclick = () => {
      currentView = name; setCur(name);
      applyView(name);
      renderViewsBar();
    };
    left.appendChild(pill);
  });

  // Right side: Save view + Columns
  const right = document.createElement('div');
  right.style.display = 'flex';
  right.style.alignItems = 'center';
  right.style.gap = '8px';
  right.style.marginLeft = 'auto';

  const plus = document.createElement('button');
  plus.className = 'view-plus';
  plus.textContent = '＋ Save view';
  plus.onclick = async () => {
    const allNow = readViews();
    const snapshot = captureState();

    if (currentView === 'Default') {
      // Default can never be overwritten; always Save As
      const name = prompt('Save current view as:');
      if (!name) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      if (trimmed === 'Default') { alert('“Default” is reserved.'); return; }

      if (allNow[trimmed]) {
        const ok = confirm(`A view named “${trimmed}” already exists. Overwrite it?`);
        if (!ok) return;
      }
      allNow[trimmed] = snapshot;
      writeViews(allNow);
      currentView = trimmed; setCur(trimmed);
      renderViewsBar();
      return;
    }

    // In a saved view: show custom Overwrite / Save New dialog
    const choice = await confirmOverwriteOrSaveAs(currentView);
    if (choice === 'overwrite') {
      allNow[currentView] = snapshot;
      writeViews(allNow);
      renderViewsBar();
      return;
    }
    if (choice !== 'saveas') return; // dismissed

    // Save As flow
    const name = prompt('Save current view as:');
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    if (trimmed === 'Default') { alert('“Default” is reserved.'); return; }

    if (allNow[trimmed]) {
      const ok = confirm(`A view named “${trimmed}” already exists. Overwrite it?`);
      if (!ok) return;
    }
    allNow[trimmed] = snapshot;
    writeViews(allNow);
    currentView = trimmed; setCur(trimmed);
    renderViewsBar();
  };

  const colBtn = document.createElement('button');
  colBtn.id = 'btnColumns';
  colBtn.className = 'btn';
  colBtn.textContent = 'Columns';
  colBtn.onclick = openColumnsPanel;

  right.appendChild(plus);
  right.appendChild(colBtn);

  bar.appendChild(left);
  bar.appendChild(right);
}

/* ---------- helpers used by columns panel ---------- */
export function currentHeaderState(){
  const ths = Array.from(document.querySelectorAll('#subsHead th[data-key]'));
  const order = ths.map(th => th.dataset.key);
  const hidden = ths.filter(th => th.dataset.hidden === '1').map(th => th.dataset.key);
  return { order, hidden };
}

/* ===== Columns panel (checklist only) ===== */
let pendingHidden = null;

export function openColumnsPanel(){
  const { order, hidden } = currentHeaderState();
  pendingHidden = new Set(hidden);

  const list = $('columns-list');
  if (!list) return;
  list.innerHTML = '';

  const byKey = Object.fromEntries(COLUMNS.map(c=>[c.key,c]));
  order.forEach(key => {
    const c = byKey[key];
    if (!c) return;

    const row = document.createElement('div');
    row.className = 'columns-item';
    row.innerHTML = `
      <label style="display:flex;align-items:center;gap:8px;">
        <input type="checkbox" ${pendingHidden.has(key) ? '' : 'checked'} />
        <span>${c.label}</span>
      </label>
    `;

    // visibility toggle
    row.querySelector('input').onchange = (ev)=>{
      if (ev.target.checked) pendingHidden.delete(key);
      else pendingHidden.add(key);
    };

    list.appendChild(row);
  });

  $('columns-backdrop').style.display='flex';
}

export function closeColumnsPanel(){
  $('columns-backdrop').style.display='none';
  pendingHidden = null;
}

export function saveColumnsPanel(){
  // keep current header order; no reordering in this popup
  const { order } = currentHeaderState();
  const hidden = pendingHidden ? Array.from(pendingHidden) : [];

  // IMPORTANT: Do NOT persist here. Only update the working UI.
  tbl.renderHead(order, hidden);
  tbl.applyFilters();
  closeColumnsPanel();
}
