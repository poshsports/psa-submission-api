// /admin/js/table.js
import { $, escapeHtml } from './util.js';
import { COLUMNS } from './columns.js';

// ===== table state =====
export let allRows = [];
export let viewRows = [];
export let sortKey = 'created_at';
export let sortDir = 'desc';
export let pageSize = 50;
export let pageIndex = 0;
// --- paging helpers (ESM-safe) ---
export function setPageIndex(i = 0) {
  pageIndex = Math.max(0, i | 0);
}
export function nextPage() {
  const totalPages = Math.max(1, Math.ceil(viewRows.length / pageSize));
  pageIndex = Math.min(pageIndex + 1, totalPages - 1);
}
export function prevPage() {
  pageIndex = Math.max(0, pageIndex - 1);
}
export function getPageIndex() {
  return pageIndex;
}


export function setSort(key, dir) {
  if (key) sortKey = key;
  if (dir) sortDir = dir;
}
export function setRows(rows) {
  allRows = Array.isArray(rows) ? rows : [];
  pageIndex = 0; // reset paging when data set changes
}
export function getSort() {
  return { sortKey, sortDir };
}

// ===== row normalization (stable shape for table) =====
export function normalizeRow(r){
  const evalAmtNum = Number(
    (r.evaluation ?? 0) ||
    (r.eval_line_sub ?? 0) ||
    (r?.totals?.evaluation ?? 0)
  ) || 0;
  const evalBool = evalAmtNum > 0;

  return {
    submission_id: r.submission_id || r.id || '',
    customer_email: r.customer_email || r.customer_em || r.email || '',
    cards: Number(r.cards ?? (Array.isArray(r.card_info) ? r.card_info.length : 0)) || 0,
    evaluation_bool: evalBool,
    evaluation: evalBool ? 'Yes' : 'No',
    grand: Number(r?.totals?.grand ?? r.grand_total ?? r.total ?? 0) || 0,
    status: r.status || '',
    grading_service: String(r.grading_service ?? r.grading_services ?? r.grading_servi ?? r.service ?? r.grading ?? '').trim(),
    created_at: r.created_at || r.inserted_at || r.submitted_at_iso || '',
    paid_at_iso: r.paid_at_iso || '',
    paid_amount: Number(r.paid_amount || 0) || 0,
    shopify_order_name: r.shopify_order_name || ''
  };
}

// ===== header render (no drag here; drag only in Columns panel) =====
export function renderHead(order, hidden){
  const hiddenSet = new Set(hidden || []);
  const head = $('subsHead');

  head.innerHTML = `
    <tr>
      ${order.map(key => {
        const col = COLUMNS.find(c => c.key === key);
        if (!col) return '';
        const caretId = 'car-' + key;
        const style = hiddenSet.has(key) ? ' style="display:none" data-hidden="1"' : '';
        return `
          <th class="${col.sortable ? 'sortable' : ''}" data-key="${key}"${style}>
            <span class="th-label">${escapeHtml(col.label)}</span>
            ${col.sortable ? `<span class="caret" id="${caretId}"></span>` : ''}
          </th>
        `;
      }).join('')}
    </tr>
  `;

  // Sorting click handlers
  head.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (sortKey === key) sortDir = (sortDir === 'asc') ? 'desc' : 'asc';
      else { sortKey = key; sortDir = 'desc'; }
      applyFilters();
      paintCarets();
    });
  });

  paintCarets();
}

export function paintCarets(){
  document.querySelectorAll('#subsHead .caret').forEach(el => el.textContent = '');
  const el = document.getElementById('car-' + sortKey);
  if (el) el.textContent = sortDir === 'asc' ? '▲' : '▼';
}

// ===== core: filter + sort + paginate =====
export function applyFilters(){
  // free-text query
  const q = ($('q')?.value || '').trim().toLowerCase();

// toolbar filters (null = not applied)
const statusSel = $('#fStatus'); // matches <select id="fStatus">
const evalSel   = $('#fEval');   // matches <select id="fEval">

  const statusFilter = (statusSel && statusSel.value && statusSel.value.toLowerCase() !== 'all')
    ? statusSel.value.toLowerCase()
    : null;

  const evalFilter = (evalSel && evalSel.value && evalSel.value.toLowerCase() !== 'all')
    ? evalSel.value.toLowerCase() // 'yes' | 'no'
    : null;

  // determine visible columns from header
  const ths = Array.from(document.querySelectorAll('#subsHead th[data-key]'))
    .filter(th => th.style.display !== 'none');
  const visibleKeys = ths.map(th => th.dataset.key);

  // filter (search + status + evaluation)
  viewRows = allRows.filter(r => {
    if (q) {
      const matchText =
        (r.customer_email && r.customer_email.toLowerCase().includes(q)) ||
        (r.submission_id && r.submission_id.toLowerCase().includes(q));
      if (!matchText) return false;
    }

    if (statusFilter) {
      const st = String(r.status || '').toLowerCase();
      if (st !== statusFilter) return false;
    }

    if (evalFilter) {
      if (evalFilter === 'yes' && !r.evaluation_bool) return false;
      if (evalFilter === 'no'  &&  r.evaluation_bool) return false;
    }

    return true;
  });

  // sort (with paid fields handled correctly)
  const dir = sortDir === 'asc' ? 1 : -1;
  viewRows.sort((a, b) => {
    if (sortKey === 'evaluation') {
      return ((a.evaluation_bool ? 1 : 0) - (b.evaluation_bool ? 1 : 0)) * dir;
    }
    if (['cards', 'grand', 'paid_amount'].includes(sortKey)) {
      return (Number(a[sortKey]) - Number(b[sortKey])) * dir;
    }
    if (['created_at', 'paid_at_iso'].includes(sortKey)) {
      const na = new Date(a[sortKey]).getTime();
      const nb = new Date(b[sortKey]).getTime();
      return ((isNaN(na) ? 0 : na) - (isNaN(nb) ? 0 : nb)) * dir;
    }
    return String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? '')) * dir;
  });

  // clamp page index and render
  pageIndex = Math.min(pageIndex, Math.floor(Math.max(0, viewRows.length - 1) / pageSize));
  renderTable(visibleKeys);
}

export function renderTable(visibleKeys){
  const body = $('subsTbody');
  const emptyEl = $('subsEmpty');

  // If the table body isn't mounted yet, safely bail (e.g., mid-login transition)
  if (!body) {
    // still try to keep pagination label sane if present
    const total0 = viewRows.length;
    const start0 = pageIndex * pageSize;
    const end0   = Math.min(start0 + pageSize, total0);
    const pageRange0 = $('page-range');
    if (pageRange0) {
      pageRange0.textContent = total0 ? `${start0 + 1}–${end0} of ${total0}` : '0–0 of 0';
    }
    const pill0 = $('countPill');
    if (pill0) pill0.textContent = String(viewRows.length);
    return;
  }

  if (!viewRows.length) {
    body.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('hide');
  } else {
    if (emptyEl) emptyEl.classList.add('hide');
  }

  const colMap = new Map(COLUMNS.map(c => [c.key, c]));
  const alignClass = (key) => (colMap.get(key)?.align === 'right' ? 'right' : '');

  // paging
  const start = pageIndex * pageSize;
  const end = Math.min(start + pageSize, viewRows.length);
  const rows = viewRows.slice(start, end);

  body.innerHTML = rows.map(r => `
    <tr>
      ${visibleKeys.map(key => {
        const col = colMap.get(key);
        const val = r[key];
        const out = col?.format ? col.format(val) : escapeHtml(String(val ?? ''));
        return `<td class="${alignClass(key)}">${out}</td>`;
      }).join('')}
    </tr>
  `).join('');

  // pagination UI (null-safe)
  const total = viewRows.length;
  const pageRange = $('page-range');
  if (pageRange) {
    pageRange.textContent = `${total ? (start + 1) : 0}–${end} of ${total}`;
  }
  const prevBtn = $('prev-page');
  if (prevBtn) prevBtn.disabled = pageIndex === 0;
  const nextBtn = $('next-page');
  if (nextBtn) nextBtn.disabled = end >= total;

  // update count pill
  const pill = $('countPill');
  if (pill) pill.textContent = String(total);
}
