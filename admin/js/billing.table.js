// /admin/js/billing.table.js
import { $, escapeHtml } from './util.js';
import { COLUMNS } from './billing.columns.js';

// ===== table state =====
export let allRows = [];
export let viewRows = [];
export let sortKey = 'returned';      // newest returned first
export let sortDir = 'desc';
export let pageSize = 50;
export let pageIndex = 0;

export { allRows as rows };

export function setPageIndex(i = 0) { pageIndex = Math.max(0, i | 0); }
export function nextPage() {
  const totalPages = Math.max(1, Math.ceil(viewRows.length / pageSize));
  pageIndex = Math.min(pageIndex + 1, totalPages - 1);
}
export function prevPage() { pageIndex = Math.max(0, pageIndex - 1); }
export function getPageIndex() { return pageIndex; }

export function setSort(key, dir) { if (key) sortKey = key; if (dir) sortDir = dir; }
export function setRows(rows) { allRows = Array.isArray(rows) ? rows : []; pageIndex = 0; }
export function getSort() { return { sortKey, sortDir }; }

// ===== helpers =====
function parseMs(v){ if (!v) return null; const ms = Date.parse(v); return Number.isNaN(ms) ? null : ms; }

// Normalize billing row (compute derived fields)
export function normalizeRow(r){
  const returnedNewest = r.returned_newest || r.returned || null;
  const returnedOldest = r.returned_oldest || r.returned || null;
  const ro = { ...r };
  ro.returned = returnedNewest;
  ro.returned_ms = parseMs(returnedNewest);
  ro.age_days = (() => {
    const ms = parseMs(returnedOldest);
    if (ms == null) return null;
    const now = Date.now();
    return Math.max(0, Math.round((now - ms) / 86400000));
  })();
  ro.subs_count = Array.isArray(r.submissions) ? r.submissions.length : (r.subs_count || 0);
  ro.id = ro.id || `cust:${(r.customer_email||'').toLowerCase()}`;
  return ro;
}

// ===== header =====
export function renderHead(order = COLUMNS.map(c => c.key), hidden = []){
  const head = document.getElementById('subsHead');
  if (!head) return;

  const hiddenSet = new Set(hidden || []);
  head.innerHTML = `
  <tr>
    <th class="__selcol" style="width:36px;text-align:center;vertical-align:middle">
      <input id="__selAll" type="checkbox" aria-label="Select all">
    </th>
    ${order.map(key => {
      const col = COLUMNS.find(c => c.key === key);
      if (!col) return '';
      const caretId = 'car-' + key;
      const attrs = hiddenSet.has(key)
        ? ' style="text-align:center;vertical-align:middle;display:none" data-hidden="1"'
        : ' style="text-align:center;vertical-align:middle"';
      return '<th class="' + (col.sortable ? 'sortable' : '') + '" data-key="' + key + '"' + attrs + '>' +
               '<span class="th-label">' + escapeHtml(col.label) + '</span>' +
               (col.sortable ? '<span class="caret" id="' + caretId + '"></span>' : '') +
             '</th>';
    }).join('')}
  </tr>`;

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
  document.querySelectorAll('#subsHead .caret').forEach(el => { if (el) el.textContent = ''; });
  const el = document.getElementById('car-' + sortKey);
  if (el) el.textContent = sortDir === 'asc' ? '▲' : '▼';
}

// ===== filter + sort + render =====
export function applyFilters(){
  // free-text search
  const q = (document.getElementById('q')?.value || '').trim().toLowerCase();

  // optional group filter (text input with id=fGroup; not yet present)
  const g = (document.getElementById('fGroup')?.value || '').trim().toLowerCase();

  // optional date range (using hidden inputs if present)
  const fromStr = document.getElementById('dateFrom')?.value || '';
  const toStr   = document.getElementById('dateTo')?.value   || '';
  const fromMs  = fromStr ? Date.parse(fromStr + 'T00:00:00')     : null;
  const toMs    = toStr   ? Date.parse(toStr   + 'T23:59:59.999') : null;

  // determine visible columns from header
  const visibleKeys = Array.from(document.querySelectorAll('#subsHead th[data-key]'))
    .filter(th => th.style.display !== 'none')
    .map(th => th.dataset.key);

  // Filter pipeline
  viewRows = allRows.filter(r => {
    if (q) {
      const txt = [
        r.customer_email, r.customer_name,
        ...(Array.isArray(r.submissions) ? r.submissions.map(s => s.submission_id) : []),
        ...(Array.isArray(r.groups) ? r.groups : [])
      ].filter(Boolean).join(' ').toLowerCase();
      if (!txt.includes(q)) return false;
    }
    if (g) {
      const gs = (r.groups || []).map(x => String(x).toLowerCase());
      if (!gs.some(x => x.includes(g))) return false;
    }
    if (fromMs != null || toMs != null) {
      const ts = r.returned_ms ?? parseMs(r.returned);
      if (ts != null) {
        if (fromMs != null && ts < fromMs) return false;
        if (toMs   != null && ts > toMs)   return false;
      }
    }
    return true;
  });

  // sort
  const dir = sortDir === 'asc' ? 1 : -1;
  viewRows.sort((a, b) => {
    if (sortKey === 'returned') {
      const na = a.returned_ms ?? parseMs(a.returned) ?? 0;
      const nb = b.returned_ms ?? parseMs(b.returned) ?? 0;
      return (na - nb) * dir;
    }
    if (sortKey === 'age_days' || sortKey === 'cards' || sortKey === 'subs_count' || sortKey === 'est_total') {
      return ((Number(a[sortKey])||0) - (Number(b[sortKey])||0)) * dir;
    }
    return String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? '')) * dir;
  });

  // clamp page and render
  pageIndex = Math.min(pageIndex, Math.floor(Math.max(0, viewRows.length - 1) / pageSize));
  renderTable(visibleKeys);
}

function wireRowOpenHandlers(tbody) {
  if (!tbody) return;
  if (tbody.__rowClick) tbody.removeEventListener('click', tbody.__rowClick);
  if (tbody.__rowKey)   tbody.removeEventListener('keydown', tbody.__rowKey);

  const onClick = (e) => {
    const tr = e.target.closest?.('tr.rowlink');
    if (!tr || tr.closest('table') !== tbody.closest('table')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (['a','button','input','select','textarea','label'].includes(tag)) return;
    // (no per-row details sheet on Billing yet)
  };
  const onKey = (e) => {};
  tbody.addEventListener('click', onClick);
  tbody.addEventListener('keydown', onKey);
  tbody.__rowClick = onClick;
  tbody.__rowKey   = onKey;
}

/* ---------- Render ---------- */
export function renderTable(visibleKeys){
  const body = $('subsTbody');
  const emptyEl = $('subsEmpty');

  if (!body) {
    const total0 = viewRows.length;
    const start0 = pageIndex * pageSize;
    const end0   = Math.min(start0 + pageSize, total0);
    const pageRange0 = $('page-range');
    if (pageRange0) pageRange0.textContent = total0 ? `${start0 + 1}–${end0} of ${total0}` : '0–0 of 0';
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

  // paging
  const start = pageIndex * pageSize;
  const end = Math.min(start + pageSize, viewRows.length);
  const rows = viewRows.slice(start, end);

  body.innerHTML = rows.map(r => {
    const id = String(r.id || r.customer_email || '').trim();
    return `
      <tr class="rowlink" data-id="${escapeHtml(id)}" tabindex="0">
        <td class="__selcol" style="text-align:center;vertical-align:middle">
          <input class="__selrow" type="checkbox" aria-label="Select row">
        </td>
        ${visibleKeys.map(key => {
          const col = colMap.get(key); if (!col) return '';
          const val = r[key];
          const out = col?.format ? col.format(val, r) : escapeHtml(String(val ?? ''));
          const align = col?.align || 'left';
          return '<td style="text-align:' + align + ';vertical-align:middle">' + out + '</td>';
        }).join('')}
      </tr>`;
  }).join('');

  // attach row open handlers after every render
  wireRowOpenHandlers(body);

  // pagination UI
  const total = viewRows.length;
  const pageRange = $('page-range');
  if (pageRange) pageRange.textContent = `${total ? (start + 1) : 0}–${end} of ${total}`;
  const prevBtn = $('prev-page');
  if (prevBtn) prevBtn.disabled = pageIndex === 0;
  const nextBtn = $('next-page');
  if (nextBtn) nextBtn.disabled = end >= total;

  // update count pill
  const pill = $('countPill');
  if (pill) pill.textContent = String(total);

  try { window.dispatchEvent(new Event('psa:table-rendered')); } catch {}
}
