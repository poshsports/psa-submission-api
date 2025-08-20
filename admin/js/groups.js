// /admin/js/groups.js
import { $, debounce, escapeHtml } from './util.js';
import { fetchGroups, fetchGroup } from './api.js';

let state = {
  status: null,     // 'Draft' | 'ReadyToShip' | 'AtPSA' | 'Returned' | 'Closed' | null
  q: '',
  limit: 20,
  offset: 0,
  hasMore: false,
  view: 'list',     // 'list' | 'detail'
  currentId: null,
  lastItems: [],    // cache last page for quick re-render on back
};

export function showGroupsView() {
  const root = $('view-groups');
  if (!root) return;
  root.innerHTML = '';
  root.classList.remove('hide');

  if (state.view === 'detail' && state.currentId) {
    renderDetail(root, state.currentId);
  } else {
    state.view = 'list';
    renderList(root);
  }
}

// ========== List View ==========
async function renderList(root) {
  root.innerHTML = `
    <div class="topbar">
      <h2 style="margin:0">Groups</h2>
      <div class="note">Read-only (create/add/remove coming later)</div>
    </div>

    <div class="filters" style="display:flex;gap:10px;align-items:center;margin:12px 0 8px">
      <input id="gq" type="text" placeholder="Search code or notes…" value="${escapeHtml(state.q)}" style="min-width:220px">
      <select id="gstatus">
        <option value="">All statuses</option>
        <option ${sel('Draft')}>Draft</option>
        <option ${sel('ReadyToShip')}>ReadyToShip</option>
        <option ${sel('AtPSA')}>AtPSA</option>
        <option ${sel('Returned')}>Returned</option>
        <option ${sel('Closed')}>Closed</option>
      </select>
      <span class="note" id="gcount"></span>
      <div style="flex:1"></div>
      <button id="gprev" class="ghost">Prev</button>
      <button id="gnext" class="ghost">Next</button>
    </div>

    <div class="table-wrap">
      <table class="data-table" id="gtbl" cellspacing="0" cellpadding="0" style="width:100%">
        <thead>
          <tr>
            <th style="width:140px">Code</th>
            <th style="width:140px">Status</th>
            <th style="width:120px">Members</th>
            <th>Notes</th>
            <th style="width:180px">Updated</th>
            <th style="width:180px">Created</th>
          </tr>
        </thead>
        <tbody id="gtbody">
          <tr><td colspan="6" class="note">Loading…</td></tr>
        </tbody>
      </table>
    </div>
  `;

  // Wire filters
  const $q = $('gq');
  const $s = $('gstatus');
  const deb = debounce(() => {
    state.q = $q.value.trim();
    state.offset = 0;
    refreshList();
  }, 250);

  $q.addEventListener('input', deb);
  $s.addEventListener('change', () => {
    const v = $s.value.trim();
    state.status = v || null;
    state.offset = 0;
    refreshList();
  });

  $('gprev').addEventListener('click', () => {
    if (state.offset <= 0) return;
    state.offset = Math.max(0, state.offset - state.limit);
    refreshList();
  });
  $('gnext').addEventListener('click', () => {
    if (!state.hasMore) return;
    state.offset = state.offset + state.limit;
    refreshList();
  });

  await refreshList();
}

function sel(v) {
  return state.status === v ? 'selected' : '';
}

async function refreshList() {
  const $body = $('gtbody');
  const $count = $('gcount');
  $body.innerHTML = `<tr><td colspan="6" class="note">Loading…</td></tr>`;
  $count.textContent = '';

  try {
    const { items, hasMore, limit, offset } = await fetchGroups({
      status: state.status,
      q: state.q,
      limit: state.limit,
      offset: state.offset
    });
    state.hasMore = !!hasMore;
    state.limit = limit;
    state.offset = offset;
    state.lastItems = items || [];

    if (!items || items.length === 0) {
      $body.innerHTML = `<tr><td colspan="6" class="note">No groups found.</td></tr>`;
      $('gprev').disabled = state.offset <= 0;
      $('gnext').disabled = true;
      $count.textContent = '';
      return;
    }

    const rows = items.map(row => {
      const code = escapeHtml(row.code || '');
      const status = escapeHtml(row.status || '');
      const notes = escapeHtml(row.notes || '');
      const cnt = Number(row.submission_count || 0);
      const updated = fmtTs(row.updated_at);
      const created = fmtTs(row.created_at);

      return `
        <tr class="clickable" data-id="${escapeHtml(row.id)}" title="Open ${code}">
          <td><strong>${code}</strong></td>
          <td>${status}</td>
          <td>${cnt}</td>
          <td>${notes}</td>
          <td>${updated}</td>
          <td>${created}</td>
        </tr>
      `;
    }).join('');

    $body.innerHTML = rows;
    $('gprev').disabled = state.offset <= 0;
    $('gnext').disabled = !state.hasMore;

    const start = state.offset + 1;
    const end = state.offset + state.lastItems.length + (state.hasMore ? '+' : '');
    $count.textContent = `Showing ${start}–${end}`;

    // Row click -> detail
    $body.querySelectorAll('tr.clickable').forEach(tr => {
      tr.addEventListener('click', () => {
        const id = tr.getAttribute('data-id');
        if (!id) return;
        state.view = 'detail';
        state.currentId = id;
        const root = $('view-groups');
        if (root) renderDetail(root, id);
      });
    });

  } catch (e) {
    $body.innerHTML = `<tr><td colspan="6" class="note">Error: ${escapeHtml(e.message || 'Failed to load')}</td></tr>`;
  }
}

function fmtTs(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString();
  } catch { return String(ts); }
}

// ========== Detail View ==========
async function renderDetail(root, id) {
  root.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <button id="gback" class="ghost">← Back</button>
      <h2 style="margin:0">Group</h2>
      <span class="note">Read-only</span>
    </div>
    <div id="gdetail">Loading…</div>
  `;

  $('gback').addEventListener('click', () => {
    state.view = 'list';
    state.currentId = null;
    renderList(root);
  });

  const $box = $('gdetail');
  try {
    const g = await fetchGroup(id);
    const grp = g || {};
    const code = escapeHtml(grp.code || '');
    const status = escapeHtml(grp.status || '');
    const notes = escapeHtml(grp.notes || '');
    const shipped = fmtTs(grp.shipped_at);
    const returned = fmtTs(grp.returned_at);
    const updated = fmtTs(grp.updated_at);
    const created = fmtTs(grp.created_at);

    const members = Array.isArray(grp.members) ? grp.members : [];
    members.sort((a,b) => (a.position ?? 0) - (b.position ?? 0));

    const rows = members.length
      ? members.map(m => `
          <tr>
            <td style="width:90px">${Number(m.position ?? 0)}</td>
            <td style="width:280px"><code>${escapeHtml(m.submission_id || '')}</code></td>
            <td>${escapeHtml(m.note || '')}</td>
          </tr>
        `).join('')
      : `<tr><td colspan="3" class="note">No members.</td></tr>`;

    $box.innerHTML = `
      <div class="card" style="padding:12px;border:1px solid #eee;border-radius:12px;background:#fff;margin-bottom:14px">
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">
          <div><div class="note">Code</div><div><strong>${code}</strong></div></div>
          <div><div class="note">Status</div><div>${status}</div></div>
          <div><div class="note">Shipped</div><div>${shipped || '—'}</div></div>
          <div><div class="note">Returned</div><div>${returned || '—'}</div></div>
          <div><div class="note">Updated</div><div>${updated}</div></div>
          <div><div class="note">Created</div><div>${created}</div></div>
        </div>
        <div style="margin-top:10px">
          <div class="note">Notes</div>
          <div>${notes || '—'}</div>
        </div>
      </div>

      <div class="table-wrap">
        <table class="data-table" cellspacing="0" cellpadding="0" style="width:100%">
          <thead>
            <tr>
              <th style="width:90px">#</th>
              <th style="width:280px">Submission</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  } catch (e) {
    $box.innerHTML = `<div class="note">Error loading group: ${escapeHtml(e.message || 'Unknown error')}</div>`;
  }
}
