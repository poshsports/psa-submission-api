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
  const bar = $('views-bar');                 // id only (no '#')
  if (!bar) return;

  bar.innerHTML = '';
  const all = readViews();

  Object.keys(all).forEach(name => {
    const pill = document.createElement('button');
    pill.className = 'view-pill' + (name === currentView ? ' active' : '');
    pill.textContent = name;
    pill.onclick = () => {
      currentView = name; setCur(name);
      applyView(name);
      renderViewsBar();
    };
    bar.appendChild(pill);
  });

  const plus = document.createElement('button');
  plus.className = 'view-plus';
  plus.textContent = '＋ Save view';
  plus.onclick = () => {
    const name = prompt('Save current view as:');
    if (!name) return;
    if (name === 'Default') { alert('“Default” is reserved.'); return; }

    const state = currentHeaderState();
    const { sortKey, sortDir } = tbl.getSort();

    const allNow = readViews();
    allNow[name] = { ...state, sortKey, sortDir };
    writeViews(allNow);

    currentView = name; setCur(name);
    renderViewsBar();
  };
  bar.appendChild(plus);
}

/* ---------- helpers used by columns panel ---------- */
export function currentHeaderState(){
  const ths = Array.from(document.querySelectorAll('#subsHead th[data-key]'));
  const order = ths.map(th => th.dataset.key);
  const hidden = ths.filter(th => th.dataset.hidden === '1').map(th => th.dataset.key);
  return { order, hidden };
}

/* ===== Columns panel (drag only here) ===== */
let pendingOrder = null;
let pendingHidden = null;

export function openColumnsPanel(){
  const { order, hidden } = currentHeaderState();
  pendingOrder = order.slice();
  pendingHidden = new Set(hidden);

  const list = $('columns-list');            // id only
  if (!list) return;
  list.innerHTML = '';

  const byKey = Object.fromEntries(COLUMNS.map(c=>[c.key,c]));

  pendingOrder.forEach(key=>{
    const c = byKey[key];
    const row = document.createElement('div');
    row.className = 'columns-item';
    row.draggable = true;
    row.dataset.key = key;
    row.innerHTML = `
      <span class="drag-handle">⠿</span>
      <label style="display:flex;align-items:center;gap:8px;">
        <input type="checkbox" ${pendingHidden.has(key)?'':'checked'} />
        <span>${c.label}</span>
      </label>
    `;

    // drag reordering
    row.addEventListener('dragstart', (e)=>{ e.dataTransfer.setData('text/plain', key); });
    row.addEventListener('dragover', (e)=>{ e.preventDefault(); });
    row.addEventListener('drop', (e)=>{
      e.preventDefault();
      const srcKey = e.dataTransfer.getData('text/plain');
      const dstKey = e.currentTarget.dataset.key;
      if(!srcKey || !dstKey || srcKey===dstKey) return;
      const from = pendingOrder.indexOf(srcKey);
      const to = pendingOrder.indexOf(dstKey);
      pendingOrder.splice(to,0, pendingOrder.splice(from,1)[0]);
      openColumnsPanel(); // re-render
    });

    // visibility
    row.querySelector('input').onchange = (ev)=>{
      if (ev.target.checked) pendingHidden.delete(key);
      else pendingHidden.add(key);
    };

    list.appendChild(row);
  });

  $('columns-backdrop').style.display='flex'; // id only
}

export function closeColumnsPanel(){
  $('columns-backdrop').style.display='none';
  pendingOrder = null;
  pendingHidden = null;
}

export function saveColumnsPanel(){
  if(!pendingOrder) return closeColumnsPanel();

  const hidden = Array.from(pendingHidden);
  const all = readViews();
  const v = all[currentView] || {};
  const { sortKey, sortDir } = tbl.getSort();

  all[currentView] = { ...(v||{}), order: pendingOrder.slice(), hidden, sortKey, sortDir };
  writeViews(all);

  tbl.renderHead(pendingOrder.slice(), hidden);
  tbl.applyFilters();
  closeColumnsPanel();
}
