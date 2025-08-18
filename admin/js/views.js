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

/* ---------- lightweight UI helpers (no new CSS needed) ---------- */

// Small anchored menu beside a button
function openViewActionsMenu(anchorEl, viewName){
  // Backdrop to capture outside clicks
  const back = document.createElement('div');
  back.style.position = 'fixed';
  back.style.inset = '0';
  back.style.zIndex = '70';
  back.style.background = 'transparent';

  // Floating menu
  const menu = document.createElement('div');
  menu.style.position = 'absolute';
  menu.style.minWidth = '200px';
  menu.style.padding = '6px';
  menu.style.background = '#fff';
  menu.style.border = '1px solid var(--line)';
  menu.style.borderRadius = '10px';
  menu.style.boxShadow = 'var(--shadow-1)';
  menu.style.zIndex = '71';

  const item = (label, onClick, danger=false) => {
    const btn = document.createElement('button');
    btn.className = 'btn' + (danger ? ' danger' : '');
    btn.style.display = 'block';
    btn.style.width = '100%';
    btn.style.textAlign = 'left';
    btn.style.border = '0';
    btn.style.margin = '4px 0';
    btn.style.padding = '8px 10px';
    btn.textContent = label;
    btn.onclick = () => { cleanup(); onClick(); };
    return btn;
  };

  // Position next to anchor
  const r = anchorEl.getBoundingClientRect();
  const top = window.scrollY + r.bottom + 6;
  const left = Math.min(window.scrollX + r.left, window.scrollX + (window.innerWidth - 220));
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;

  // Build items
  menu.append(
    item('Rename view', () => doRenameView(viewName)),
    item('Duplicate view', () => doDuplicateView(viewName)),
    item('Delete view', () => doDeleteView(viewName), true)
  );

  function cleanup(){
    back.remove();
    menu.remove();
  }
  back.onclick = cleanup;

  document.body.append(back, menu);
}

// Modal: two-button confirm for Overwrite/Save New (already used by Save View)
function confirmOverwriteOrSaveAs(viewName){
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    panel.style.maxWidth = '420px';

    const h = document.createElement('h3'); h.textContent = 'Save changes?';
    const p = document.createElement('p'); p.className = 'muted'; p.textContent = `Update “${viewName}” or save a new view.`;

    const footer = document.createElement('div');
    footer.className = 'row';
    footer.style.justifyContent = 'flex-end';
    footer.style.gap = '8px';

    const btnSaveAs = document.createElement('button'); btnSaveAs.className = 'btn'; btnSaveAs.textContent = 'Save New';
    const btnOverwrite = document.createElement('button'); btnOverwrite.className = 'btn primary'; btnOverwrite.textContent = 'Overwrite';

    btnSaveAs.onclick = () => done('saveas');
    btnOverwrite.onclick = () => done('overwrite');
    overlay.onclick = (e) => { if (e.target === overlay) done(null); };

    footer.append(btnSaveAs, btnOverwrite);
    panel.append(h, p, footer);
    overlay.append(panel);
    document.body.append(overlay);

    function done(result){ overlay.remove(); resolve(result); }
  });
}

// Modal: prompt for a view name. Returns string | null
function promptViewName({ title, submitLabel, initial }){
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    panel.style.maxWidth = '480px';

    const h = document.createElement('h3'); h.textContent = title;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = initial || '';
    input.style.width = '100%';
    input.style.margin = '12px 0';
    input.autofocus = true;

    const footer = document.createElement('div');
    footer.className = 'row';
    footer.style.justifyContent = 'flex-end';
    footer.style.gap = '8px';

    const btnCancel = document.createElement('button'); btnCancel.className = 'btn'; btnCancel.textContent = 'Cancel';
    const btnSave = document.createElement('button'); btnSave.className = 'btn primary'; btnSave.textContent = submitLabel || 'Save';

    btnCancel.onclick = () => done(null);
    btnSave.onclick = () => done(input.value);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnSave.click(); });
    overlay.onclick = (e) => { if (e.target === overlay) done(null); };

    footer.append(btnCancel, btnSave);
    panel.append(h, input, footer);
    overlay.append(panel);
    document.body.append(overlay);

    function done(val){ overlay.remove(); resolve(val); }
    setTimeout(()=>input.focus(), 0);
  });
}

// Modal: confirm delete (returns true/false)
function confirmDeleteView(name){
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    panel.style.maxWidth = '420px';

    const h = document.createElement('h3'); h.textContent = 'Delete view?';
    const p = document.createElement('p'); p.className = 'muted'; p.textContent = `Are you sure you want to delete “${name}”?`;

    const footer = document.createElement('div');
    footer.className = 'row';
    footer.style.justifyContent = 'flex-end';
    footer.style.gap = '8px';

    const btnCancel = document.createElement('button'); btnCancel.className = 'btn'; btnCancel.textContent = 'Cancel';
    const btnDelete = document.createElement('button'); btnDelete.className = 'btn danger'; btnDelete.textContent = 'Delete';

    btnCancel.onclick = () => done(false);
    btnDelete.onclick = () => done(true);
    overlay.onclick = (e) => { if (e.target === overlay) done(false); };

    footer.append(btnCancel, btnDelete);
    panel.append(h, p, footer);
    overlay.append(panel);
    document.body.append(overlay);

    function done(val){ overlay.remove(); resolve(val); }
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
    // Wrap so we can append a caret next to the active pill
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '4px';

    const pill = document.createElement('button');
    pill.className = 'view-pill' + (name === currentView ? ' active' : '');
    pill.textContent = name;
    pill.onclick = () => {
      currentView = name; setCur(name);
      applyView(name);
      renderViewsBar();
    };
    wrap.appendChild(pill);

    // Only show actions caret for the active, non-Default view
    if (name === currentView && name !== 'Default') {
      const caret = document.createElement('button');
      caret.className = 'btn';
      caret.setAttribute('aria-label', 'View actions');
      caret.textContent = '▾';
      caret.style.padding = '4px 8px';
      caret.style.borderRadius = '999px';
      caret.onclick = (e) => { e.stopPropagation(); openViewActionsMenu(caret, name); };
      wrap.appendChild(caret);
    }

    left.appendChild(wrap);
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

    // Saved view: Overwrite or Save New
    const choice = await confirmOverwriteOrSaveAs(currentView);
    if (choice === 'overwrite') {
      allNow[currentView] = snapshot;
      writeViews(allNow);
      renderViewsBar();
      return;
    }
    if (choice !== 'saveas') return; // dismissed

    // Save As
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

/* ---------- actions: rename / duplicate / delete ---------- */
async function doRenameView(oldName){
  if (oldName === 'Default') return; // safety
  const all = readViews();
  const initial = oldName;
  const val = await promptViewName({ title: 'Rename view', submitLabel: 'Save', initial });
  if (val == null) return;
  const next = val.trim();
  if (!next || next === oldName) return;
  if (next === 'Default') { alert('“Default” is reserved.'); return; }

  // If target exists, confirm overwrite
  if (all[next] && next !== oldName){
    const ok = confirm(`A view named “${next}” already exists. Overwrite it?`);
    if (!ok) return;
  }

  // Move/overwrite
  all[next] = all[oldName];
  delete all[oldName];
  writeViews(all);

  currentView = next; setCur(next);
  renderViewsBar();
}

async function doDuplicateView(name){
  const all = readViews();
  const suggested = `${name} (copy)`;
  const val = await promptViewName({ title: 'Duplicate view', submitLabel: 'Duplicate view', initial: suggested });
  if (val == null) return;
  const next = val.trim();
  if (!next) return;
  if (next === 'Default') { alert('“Default” is reserved.'); return; }

  const snapshot = captureState(); // duplicate the current working state
  if (all[next]) {
    const ok = confirm(`A view named “${next}” already exists. Overwrite it?`);
    if (!ok) return;
  }
  all[next] = snapshot;
  writeViews(all);

  currentView = next; setCur(next);
  renderViewsBar();
}

async function doDeleteView(name){
  if (name === 'Default') return; // safety
  const all = readViews();
  const yes = await confirmDeleteView(name);
  if (!yes) return;

  delete all[name];
  writeViews(all);

  // Fallback to Default
  currentView = 'Default'; setCur('Default');
  applyView('Default');
  renderViewsBar();
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
