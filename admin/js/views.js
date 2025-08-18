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

/* ---------- lightweight UI helpers ---------- */

// Small anchored menu beside an element
function openViewActionsMenu(anchorEl, viewName){
  const back = document.createElement('div');
  back.style.position = 'fixed';
  back.style.inset = '0';
  back.style.zIndex = '70';
  back.style.background = 'transparent';

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

  const r = anchorEl.getBoundingClientRect();
  const top = window.scrollY + r.bottom + 6;
  const left = Math.min(window.scrollX + r.left, window.scrollX + (window.innerWidth - 220));
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;

  menu.append(
    item('Rename view', () => doRenameView(viewName)),
    item('Duplicate view', () => doDuplicateView(viewName)),
    item('Delete view', () => doDeleteView(viewName), true)
  );

  function cleanup(){ back.remove(); menu.remove(); }
  back.onclick = cleanup;
  document.body.append(back, menu);
}

// Custom Overwrite / Save New dialog
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

// Prompt for a view name (rename/duplicate/save-as)
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

// Confirm delete
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

/* Persist a snapshot according to our Saved-View rules */
async function saveSnapshotToViews(snapshot){
  const allNow = readViews();

  if (currentView === 'Default') {
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

  const choice = await confirmOverwriteOrSaveAs(currentView);
  if (choice === 'overwrite') {
    allNow[currentView] = snapshot;
    writeViews(allNow);
    renderViewsBar();
    return;
  }
  if (choice !== 'saveas') return;

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

/* ---------- EDIT COLUMNS MODE (Shopify-style) ---------- */
let editMode = false;
let baselineOrder = null;
let baselineHidden = null;
let editOrder = null;
let editHidden = null;

function renderEditHead(){
  // Render header with current edit state, then wire drag + eye toggles
  tbl.renderHead(editOrder.slice(), Array.from(editHidden));
  tbl.applyFilters();

  const thead = document.querySelector('#subsHead');
  const ths = Array.from(thead?.querySelectorAll('th[data-key]') || []);

  // Tag thead so CSS can style differently
  thead?.classList.add('edit-cols');

  const byKey = Object.fromEntries(COLUMNS.map(c=>[c.key,c]));

  ths.forEach(th => {
    const key = th.dataset.key;
    const meta = byKey[key];
    if (!meta) return;

    // Disable sorting while editing
    th.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); }, true);
    th.style.userSelect = 'none';
    th.style.cursor = 'default';

    // Build tools container
    let tools = th.querySelector('.th-tools');
    if (!tools) {
      tools = document.createElement('span');
      tools.className = 'th-tools';
      th.appendChild(tools);
    }
    tools.innerHTML = '';

    // Drag handle
    const drag = document.createElement('span');
    drag.className = 'drag-handle';
    drag.title = 'Drag to reorder';
    drag.textContent = '⠿';
    drag.draggable = true;

    drag.addEventListener('dragstart', (e)=>{
      e.dataTransfer.setData('text/plain', key);
      e.dataTransfer.effectAllowed = 'move';
    });

    th.addEventListener('dragover', (e)=>{ e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });

    th.addEventListener('drop', (e)=>{
      e.preventDefault();
      const srcKey = e.dataTransfer.getData('text/plain');
      const dstKey = key;
      if (!srcKey || !dstKey || srcKey === dstKey) return;
      const from = editOrder.indexOf(srcKey);
      const to = editOrder.indexOf(dstKey);
      if (from === -1 || to === -1) return;
      editOrder.splice(to, 0, editOrder.splice(from,1)[0]);
      renderEditHead(); // re-render and rewire
    });

    // Eye toggle
    const eye = document.createElement('button');
    eye.className = 'th-eye btn';
    const isHidden = editHidden.has(key);
    eye.title = isHidden ? 'Show column' : 'Hide column';
    eye.textContent = isHidden ? '🙈' : '👁';
    eye.setAttribute('aria-pressed', String(!isHidden));
    eye.onclick = (e)=>{
      e.stopPropagation();
      if (editHidden.has(key)) editHidden.delete(key);
      else editHidden.add(key);
      renderEditHead();
    };

    tools.append(drag, eye);
  });
}

export function openColumnsPanel(){
  // Enter edit mode
  const { order, hidden } = currentHeaderState();
  baselineOrder = order.slice();
  baselineHidden = new Set(hidden);

  editOrder = order.slice();
  editHidden = new Set(hidden);

  editMode = true;
  renderEditHead();
  renderViewsBar();
}

export function closeColumnsPanel(){
  // Cancel edit: restore baseline
  if (!editMode) return;
  tbl.renderHead(baselineOrder.slice(), Array.from(baselineHidden));
  tbl.applyFilters();

  const thead = document.querySelector('#subsHead');
  thead?.classList.remove('edit-cols');

  editMode = false;
  baselineOrder = baselineHidden = editOrder = editHidden = null;
  renderViewsBar();
}

export async function saveColumnsPanel(){
  // Apply edit to working UI, then run saved-view persistence flow
  if (!editMode) return;
  const snapshot = {
    order: editOrder.slice(),
    hidden: Array.from(editHidden),
    ...tbl.getSort()
  };

  // Apply to table immediately
  tbl.renderHead(snapshot.order, snapshot.hidden);
  tbl.applyFilters();

  const thead = document.querySelector('#subsHead');
  thead?.classList.remove('edit-cols');

  editMode = false;
  baselineOrder = baselineHidden = editOrder = editHidden = null;
  renderViewsBar();

  // Persist according to rules (Default not overwritten etc.)
  await saveSnapshotToViews(snapshot);
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

    const label = document.createElement('span');
    label.textContent = name;
    pill.appendChild(label);

    pill.onclick = () => {
      if (name !== currentView) {
        currentView = name; setCur(name);
        applyView(name);
        renderViewsBar();
      }
    };

    if (name === currentView && name !== 'Default') {
      const caret = document.createElement('span');
      caret.textContent = '▾';
      caret.setAttribute('aria-label', 'View actions');
      caret.setAttribute('role', 'button');
      caret.tabIndex = 0;
      caret.style.marginLeft = '6px';
      caret.style.opacity = '.85';
      caret.style.cursor = 'pointer';
      caret.style.userSelect = 'none';
      const openMenu = (e) => { e.stopPropagation(); openViewActionsMenu(caret, name); };
      caret.onclick = openMenu;
      caret.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMenu(e); }
      });
      pill.appendChild(caret);
    }

    left.appendChild(pill);
  });

  // Right side: Save/Cancel in edit mode OR Columns + Save view
  const right = document.createElement('div');
  right.style.display = 'flex';
  right.style.alignItems = 'center';
  right.style.gap = '8px';
  right.style.marginLeft = 'auto';

  if (editMode) {
    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'columns-cancel';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = closeColumnsPanel;

    const saveBtn = document.createElement('button');
    saveBtn.id = 'columns-save';
    saveBtn.className = 'btn primary';
    saveBtn.textContent = 'Save';
    saveBtn.onclick = saveColumnsPanel;

    right.append(cancelBtn, saveBtn);
  } else {
    const plus = document.createElement('button');
    plus.className = 'view-plus';
    plus.textContent = '＋ Save view';
    plus.onclick = async () => {
      const snapshot = captureState();
      await saveSnapshotToViews(snapshot);
    };

    const colBtn = document.createElement('button');
    colBtn.id = 'btnColumns';
    colBtn.className = 'btn';
    colBtn.textContent = 'Columns';
    colBtn.title = 'Edit columns';
    colBtn.onclick = openColumnsPanel;

    right.append(plus, colBtn);
  }

  bar.appendChild(left);
  bar.appendChild(right);
}

/* ---------- actions: rename / duplicate / delete ---------- */
async function doRenameView(oldName){
  if (oldName === 'Default') return;
  const all = readViews();
  const val = await promptViewName({ title: 'Rename view', submitLabel: 'Save', initial: oldName });
  if (val == null) return;
  const next = val.trim();
  if (!next || next === oldName) return;
  if (next === 'Default') { alert('“Default” is reserved.'); return; }

  if (all[next] && next !== oldName){
    const ok = confirm(`A view named “${next}” already exists. Overwrite it?`);
    if (!ok) return;
  }

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

  const snapshot = captureState();
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
  if (name === 'Default') return;
  const all = readViews();
  const yes = await confirmDeleteView(name);
  if (!yes) return;

  delete all[name];
  writeViews(all);

  currentView = 'Default'; setCur('Default');
  applyView('Default');
  renderViewsBar();
}

/* ---------- helpers used by edit mode & capture ---------- */
export function currentHeaderState(){
  const ths = Array.from(document.querySelectorAll('#subsHead th[data-key]'));
  const order = ths.map(th => th.dataset.key);
  const hidden = ths.filter(th => th.dataset.hidden === '1').map(th => th.dataset.key);
  return { order, hidden };
}

/* ===== (legacy names kept for wiring) ===== */
// openColumnsPanel  -> enter edit mode
// closeColumnsPanel -> cancel edit
// saveColumnsPanel  -> save edit (persist via Saved-View rules)
