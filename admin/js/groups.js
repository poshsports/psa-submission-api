import { $, debounce, escapeHtml, prettyStatus } from './util.js';
import { fetchGroups, logout, deleteGroup } from './api.js';


// ========== Auth & sidebar wiring (standalone Groups page) ==========
// (unchanged)
async function doLogout(e){
  e?.preventDefault?.();
  try { await logout(); } catch {}
  window.location.replace('/admin'); // leave
}
function ensureSignoutWired(){
  const el = $('sidebar-signout');
  if (!el) return;
  el.addEventListener('click', doLogout);
  el.onclick = doLogout;
}
function wireSidebarNav(){
  $('nav-active')?.addEventListener('click', (e) => { e.preventDefault(); window.location.assign('/admin'); });
  $('nav-groups')?.classList?.add('active');
}

// ========== Local state ==========
let state = {
  status: null,     // 'Draft' | 'ReadyToShip' | 'AtPSA' | 'Returned' | 'Closed' | null
  q: '',
  limit: 50,        // 50 like Active submissions
  offset: 0,
  hasMore: false,
  total: null,      // new: when API returns total, we use it
  view: 'list',     // 'list' | 'detail'
  currentId: null,
  lastItems: [],    // cache last page for quick re-render on back
};
// sequence guard to avoid stale async renders clobbering the UI
let listReqSeq = 0;
// ===== selection & delete helpers (header Delete button) =====
let selectedGroup = { id: null, code: '', members: 0 };

const btnDelete = () => document.getElementById('btnDeleteGroup');

function enableDelete(enabled){
  const b = btnDelete(); if (b) b.disabled = !enabled;
}

function clearSelectionUI(){
  document.querySelectorAll('#gtbody tr.selected').forEach(tr => {
    tr.classList.remove('selected');
    tr.style.backgroundColor = '';
  });
  selectedGroup = { id: null, code: '', members: 0 };
  enableDelete(false);
}

function wireDeleteButtonOnce(){
  const b = btnDelete();
  if (!b || b.__wired) return;
  b.__wired = true;
  b.addEventListener('click', onDeleteClicked);
}

async function onDeleteClicked(){
  const { id, code, members } = selectedGroup;
  if (!id || !code) return;

  const typed = prompt(
  `Delete ${code}?\n\n` +
  `This will NOT delete submissions or cards.\n` +
  `It will unlink ${members} submission${members===1?'':'s'} and clear their group field.\n\n` +
  `Type "delete" to confirm.`
);
// Require the user to type the word “delete” (case‑insensitive)
if (!typed || typed.trim().toLowerCase() !== 'delete') return;

  const b = btnDelete(); if (b) b.disabled = true;
  try {
    // NOTE: you must export deleteGroup from api.js and import it at top:
    // import { fetchGroups, logout, deleteGroup } from './api.js';
    const res = await deleteGroup(code);
    const unlinkedSubs  = Number(res.unlinked_submissions ?? res.submissions ?? members ?? 0);
    const unlinkedCards = Number(res.unlinked_cards ?? res.cards ?? 0);
    alert(`Deleted ${code}.\nUnlinked ${unlinkedSubs} submission${unlinkedSubs===1?'':'s'} and ${unlinkedCards} card${unlinkedCards===1?'':'s'}.`);

    await refreshList();
    clearSelectionUI();
  } catch (e) {
    alert(e.message || 'Delete failed.');
    enableDelete(true);
  }
}


// --- make the groups table area behave like Active submissions ---
function ensureScroller() {
  // target the same wrapper you already render
  const wrap = document.querySelector('#view-groups .table-wrap');
  if (!wrap) return;

  // compute available height from its top to bottom of viewport
  const rect = wrap.getBoundingClientRect();
  const avail = window.innerHeight - rect.top - 16; // a little breathing room
  wrap.style.maxHeight = `${Math.max(160, avail)}px`;
  wrap.style.overflow = 'auto';
  wrap.style.webkitOverflowScrolling = 'touch';

  // allow horizontal scroll if columns overflow
  const tbl = wrap.querySelector('table');
  if (tbl) tbl.style.minWidth = '1000px';
}

// Public entry (idempotent mount)
export function showGroupsView() {
  const root = $('view-groups');
  if (!root) return;

  // Safer than innerHTML='' — removes children + their listeners in one go
  root.replaceChildren();
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
    <div class="toolbar" style="display:flex;gap:10px;align-items:center;margin-bottom:8px">
  <h2 style="margin:0">Groups</h2>
  <span class="note">Select a row, then click “Delete group…” in the header</span>
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

  ensureScroller();
  window.addEventListener('resize', ensureScroller, { passive: true });

  // Wire filters
  const $q = $('gq');
  const $s = $('gstatus');
  const deb = debounce(() => {
    state.q = $q.value.trim();
    state.offset = 0;
    refreshList();
  }, 250);

  $q?.addEventListener('input', deb);
  $s?.addEventListener('change', () => {
    const v = $s.value.trim();
    state.status = v || null;
    state.offset = 0;
    refreshList();
  });

  $('gprev')?.addEventListener('click', () => {
    if (state.offset <= 0) return;
    state.offset = Math.max(0, state.offset - state.limit);
    refreshList();
  });
  $('gnext')?.addEventListener('click', () => {
    // if we know the total, don't overshoot; otherwise rely on hasMore
    if (state.total != null) {
      if (state.offset + state.limit >= state.total) return;
    } else if (!state.hasMore) {
      return;
    }
    state.offset = state.offset + state.limit;
    refreshList();
  });

  await refreshList();
  wireDeleteButtonOnce();
  enableDelete(!!selectedGroup.id);
}

function sel(v) { return state.status === v ? 'selected' : ''; }

async function refreshList() {
  const mySeq = ++listReqSeq;

  const $body = $('gtbody');
  const $count = $('gcount');
  if ($body) $body.innerHTML = `<tr><td colspan="6" class="note">Loading…</td></tr>`;
  if ($count) $count.textContent = '';

  try {
    const payload = await fetchGroups({
      status: state.status,
      q: state.q,
      limit: state.limit,
      offset: state.offset
    });

    // If a newer request started while this one was in-flight, abort applying it
    if (mySeq !== listReqSeq) return;

    const items = payload?.items || payload?.rows || payload?.groups || payload?.data || [];
    const limit = Number(payload?.limit ?? state.limit);
    const offset = Number(payload?.offset ?? state.offset);
    const total = (payload?.total != null ? Number(payload.total) : null);
    const hasMoreFromApi = payload?.hasMore ?? payload?.has_more;

    state.lastItems = Array.isArray(items) ? items : [];
    state.limit = limit;
    state.offset = offset;
    state.total = (total != null && !Number.isNaN(total)) ? total : null;

    // hasMore logic: prefer explicit flag; else infer
    if (hasMoreFromApi != null) {
      state.hasMore = !!hasMoreFromApi;
    } else if (state.total != null) {
      state.hasMore = (state.offset + state.lastItems.length) < state.total;
    } else {
      state.hasMore = state.lastItems.length === state.limit; // heuristic
    }

    if (!$body) return;

    if (!state.lastItems.length) {
      $body.innerHTML = `<tr><td colspan="6" class="note">No groups found.</td></tr>`;
      const prev = $('gprev'), next = $('gnext');
      if (prev) prev.disabled = state.offset <= 0;
      if (next) next.disabled = true;
      if ($count) $count.textContent = '';
      ensureScroller();
      return;
    }

    const rows = state.lastItems.map(row => {
      const id    = String(row.id ?? '').trim();
      const code  = escapeHtml(row.code || '');
      const status = escapeHtml(row.status || '');
      const notes  = escapeHtml(row.notes  || '');
      const cnt = Number(row.submission_count ?? row.members ?? row.member_count ?? 0);
      const updated = fmtTs(row.updated_at);
      const created = fmtTs(row.created_at);

       return `
            <tr class="selectable" tabindex="0"
                data-id="${escapeHtml(id)}"
                data-code="${code}"
                data-members="${cnt}"
                title="Double-click to open ${code}">
              <td><strong>${code}</strong></td>
              <td>${status}</td>
              <td data-col="members">${cnt}</td>
              <td>${notes}</td>
              <td>${updated}</td>
              <td>${created}</td>
            </tr>
          `;
    }).join('');

    $body.innerHTML = rows;

    const prev = $('gprev'), next = $('gnext');
    if (prev) prev.disabled = state.offset <= 0;
    if (next) {
      next.disabled = state.total != null
        ? (state.offset + state.lastItems.length) >= state.total
        : !state.hasMore;
    }

    // Counter text like the submissions page:
    if ($count) {
      const start = state.offset + 1;
      const end = state.offset + state.lastItems.length;
      if (state.total != null) {
        $count.textContent = `Showing ${start}–${end} of ${state.total}`;
      } else {
        // fallback when API doesn’t return total
        $count.textContent = `Showing ${start}–${end}${state.hasMore ? '+' : ''}`;
      }
    }

   // Single-click selects (enables header Delete); double-click opens details
const selectRow = (tr) => {
  // remove selection and inline highlight from any previously selected rows
  document.querySelectorAll('#gtbody tr.selected').forEach(x => {
    x.classList.remove('selected');
    x.style.backgroundColor = '';
  });
  // mark this row as selected and apply a highlight
  tr.classList.add('selected');
  tr.style.backgroundColor = '#e6f0ff'; // choose your preferred colour here
  selectedGroup = {
    id: tr.getAttribute('data-id'),
    code: tr.getAttribute('data-code'),
    members: Number(tr.getAttribute('data-members') || 0),
  };
  enableDelete(!!selectedGroup.id);
  tr.focus?.();
};

const openDetailFromRow = (tr) => {
  const id = tr.getAttribute('data-id');
  const code = tr.getAttribute('data-code');
  if (!id) return;
  state.view = 'detail';
  state.currentId = id;
  const root = $('view-groups');
  if (root) renderDetail(root, id, code);
};

$body.querySelectorAll('tr.selectable').forEach(tr => {
  tr.addEventListener('click', () => selectRow(tr));
  tr.addEventListener('dblclick', () => openDetailFromRow(tr));
  tr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openDetailFromRow(tr);
    if (e.key === 'Escape') clearSelectionUI();
  });
});


    ensureScroller();
  } catch (e) {
    if ($body) $body.innerHTML = `<tr><td colspan="6" class="note">Error: ${escapeHtml(e.message || 'Failed to load')}</td></tr>`;
    ensureScroller();
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

// Show bulk only for AtPSA, or for Returned when any row is still "Shipped Back to Us"
function updateBulkStatusVisibility(groupStatus, canBulk) {
  const wrap = document.getElementById('bulk-status-ctrls');
  if (!wrap) return;
  const s = String(groupStatus || '').toLowerCase();
  const shouldHide =
    s === 'closed' ||                // never in Closed
    (!canBulk && s === 'returned');  // lock bulk after we've marked all Received Back
  wrap.style.display = shouldHide ? 'none' : '';
}


// ========== Detail View ==========
// (unchanged except for tiny formatting nits)
async function renderDetail(root, id, codeHint) {
root.innerHTML = `
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
    <button id="gback" class="ghost">← Back</button>
    <h2 style="margin:0">Group</h2>
    <span class="note">Reorder cards by editing “Card #”</span>
    <div style="flex:1"></div>
    <button id="btnEditOrder" class="ghost">Edit Card #</button>
    <button id="btnSaveOrder" class="primary" disabled style="display:none">Save order</button>
    <button id="btnCancelOrder" class="ghost" style="display:none">Cancel</button>
    <button id="btnSaveStatuses" class="primary" disabled title="Save status changes">Save status changes</button>
 <div id="bulk-status-ctrls" class="bulk-status" style="display:flex;align-items:center;gap:6px">
    <label for="bulkStatus" class="note">Set submissions status:</label>
    <select id="bulkStatus" style="min-width:220px"></select>
    <button id="applyBulkStatus" class="ghost" disabled>Apply</button>
 </div>
    <a id="open-subs" href="/admin/index.html">Open Active submissions</a>
  </div>
  <div id="gdetail">Loading…</div>
`;

  $('gback')?.addEventListener('click', () => {
    state.view = 'list';
    state.currentId = null;
    renderList(root);
  });

  const $box = $('gdetail');
  try {
    // Fetch the group (include all the data we need in one go)
    const res = await fetch(
      `/api/admin/groups/${encodeURIComponent(id)}?include=members,submissions,cards`,
      { credentials: 'same-origin' }
    );
    if (!res.ok) throw new Error('group fetch failed');
    const payload = await res.json();
    if (payload && payload.ok === false) throw new Error(payload.error || 'Group fetch failed');
    const grp = payload?.group ?? payload;

    const safe = (v) => escapeHtml(String(v ?? ''));

    // --- date-only helper for any ISO/ts value ---
    const toYMD = (val) => {
      if (!val) return '';
      const s = String(val);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;  // already YYYY-MM-DD
      try { return new Date(s).toISOString().slice(0, 10); } catch { return s.slice(0, 10); }
    };

    // Header fields
    const codeOut     = safe(grp?.code || codeHint || '');
    const statusOut   = safe(grp?.status || '');
    const notesOut    = safe(grp?.notes || '');
    const shippedOut  = fmtTs(grp?.shipped_at)  || '—';
    const returnedOut = fmtTs(grp?.returned_at) || '—';
    const updatedOut  = fmtTs(grp?.updated_at)  || '—';
    const createdOut  = fmtTs(grp?.created_at)  || '—';

    // Data returned by API
    const members = Array.isArray(grp?.members) ? grp.members : [];
    const submissions = Array.isArray(grp?.submissions) ? grp.submissions : [];
    const cards = Array.isArray(grp?.cards) ? grp.cards : [];

    // Map submissions for quick lookup (status/email/grading_service fallback)
    const subById = new Map(submissions.map(s => [String(s.id), s]));

// ---- Status dropdown helpers (UI only in Step 1) ----
const POST_PSA_ORDER = ['received_from_psa','balance_due','paid','shipped_to_customer','delivered'];
const POST_PSA_SET   = new Set(POST_PSA_ORDER);
const postPsaLabel   = (v) => prettyStatus(v);

// Which status should a row *show*? (submission governs once it's post-PSA)
function effectiveRowStatus(cardRow){
  const sid  = String(cardRow.submission_id || '');
  const sSub = String(subById.get(sid)?.status ?? '').toLowerCase();
  const sCard= String(cardRow.status ?? '').toLowerCase();

  if (POST_PSA_SET.has(sSub)) return sSub;                       // submission advanced
  if (sSub === 'received_from_psa' && POST_PSA_SET.has(sCard))   // per-card override
    return sCard;
  return sSub || sCard || '';
}

const CARD_COLS = [
  { label: 'Created',    fmt: (c) => safe(c._created_on || '') },
  { label: 'Submission', fmt: (c) => safe(c.submission_id) },
  {
    label: 'Card',
    fmt: (c) => {
      const desc = (c.card_description && String(c.card_description).trim())
        ? safe(c.card_description) : '';
      if (desc) return desc;
      const bits = [c.year, c.brand, c.set, c.player, c.card_number, c.variation]
        .filter(v => v != null && String(v).trim() !== '')
        .map(v => safe(v));
      return bits.join(' · ') || '—';
    }
  },
  {
    label: 'Card #',
    fmt: (c) => {
      const n = (c.group_card_no ?? null);
      const txt = (n == null || Number.isNaN(Number(n))) ? '—' : String(n);
      return `<span class="cardno-read">${txt}</span>`;
    }
  },
  { label: 'Break date',    fmt: (c) => safe(c._break_on || '') },
  { label: 'Break #',       fmt: (c) => safe(c.break_number || '') },
  { label: 'Break channel', fmt: (c) => safe(c.break_channel || '') },

  // Status column: becomes a dropdown in post-PSA phase
  {
    label: 'Status',
    fmt: (c) => {
      const sid   = String(c.submission_id || '');
      const eff   = effectiveRowStatus(c) || 'received_from_psa';
      const gStat = String(grp?.status || '').toLowerCase();   // group status

      // Show the select once we're in the final/bulk stage
      const showSelect = (gStat === 'returned') || POST_PSA_SET.has(eff);

      if (!showSelect) {
        return eff ? escapeHtml(prettyStatus(eff)) : '—';
      }

      const options = POST_PSA_ORDER.map(v => {
        const sel = (v === eff) ? 'selected' : '';
        return `<option value="${v}" ${sel}>${escapeHtml(postPsaLabel(v))}</option>`;
      }).join('');

      return `
        <select class="row-status"
                data-sid="${escapeHtml(sid)}"
                data-card-id="${escapeHtml(String(c.id || ''))}">
          ${options}
        </select>
      `;
    },
  },

  {
    label: 'Service',
    fmt: (c) => safe(
      c.grading_service ||
      subById.get(String(c.submission_id))?.grading_service ||
      ''
    ),
  },

  { label: 'Notes', fmt: (c) => safe(c.notes || '') },
];

    // Build rows: prefer cards; if none, fall back to members/submissions only
    const memberOrder = new Map(members.map((m, i) => [String(m.submission_id), i]));

    const rowsData = (Array.isArray(cards) && cards.length > 0)
      // cards come from API; add _created_on if missing
      ? cards.map(r => ({ ...r, _created_on: r._created_on || toYMD(r.created_at) }))
      : members.map(m => {
          const sid = String(m.submission_id || '');
          const sub = subById.get(sid) || {};
          const createdFrom = sub.created_at || m.created_at || null;
          return {
            // shape it like a "card" row so CARD_COLS formats it
            created_at: createdFrom,
            _created_on: toYMD(createdFrom),
            submission_id: sid,
            status: sub.status || '',
            grading_service: sub.grading_service || '',
            year: '',
            brand: '',
            set: '',
            player: '',
            card_number: '',
            variation: '',
            notes: m.note || '',
            card_index: 0
          };
        });

    // Keep rows aligned to member order, then by card_index if present
rowsData.sort((a, b) => {
  const ag = (a.group_card_no != null) ? Number(a.group_card_no) : null;
  const bg = (b.group_card_no != null) ? Number(b.group_card_no) : null;

  // Prefer explicit group numbering when available
  if (ag != null && bg != null && ag !== bg) return ag - bg;

  // Fallback to previous stable ordering (member order, then card_index)
  const oa = memberOrder.get(String(a.submission_id)) ?? 0;
  const ob = memberOrder.get(String(b.submission_id)) ?? 0;
  if (oa !== ob) return oa - ob;
  return (a.card_index ?? 0) - (b.card_index ?? 0);
});
    
    // Build the table HTML
    const table = `
      <table class="data-table" cellspacing="0" cellpadding="0" style="width:100%">
        <thead><tr>${CARD_COLS.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
        <tbody>
          ${ rowsData.length
  ? rowsData.map(r => `
      <tr data-card-id="${escapeHtml(String(r.id))}">
        ${CARD_COLS.map(col => `<td>${col.fmt(r)}</td>`).join('')}
      </tr>
    `).join('')
  : `<tr><td colspan="${CARD_COLS.length}" class="note">No members.</td></tr>`
}
        </tbody>
      </table>
    `;

    // Render
    if ($box) {
      $box.innerHTML = `
        <div class="card" style="padding:12px;border:1px solid #eee;border-radius:12px;background:#fff;margin-bottom:14px">
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">
            <div><div class="note">Code</div><div><strong>${codeOut}</strong></div></div>
            <div><div class="note">Status</div><div>${statusOut || '—'}</div></div>
            <div><div class="note">Shipped</div><div>${shippedOut}</div></div>
            <div><div class="note">Returned</div><div>${returnedOut}</div></div>
            <div><div class="note">Updated</div><div>${updatedOut}</div></div>
            <div><div class="note">Created</div><div>${createdOut}</div></div>
          </div>
          <div style="margin-top:10px">
            <div class="note">Notes</div>
            <div>${notesOut || '—'}</div>
          </div>
        </div>

        <div class="table-wrap">
          ${table}
        </div>
      `;
      ensureScroller();
// --- Bulk status (submissions in this group) ---
// Supported bulk steps by phase:
// Draft          -> ready_to_ship, at_psa
// ReadyToShip    -> at_psa
// AtPSA          -> shipped_back_to_us, received_from_psa
// Returned       -> received_from_psa (only if some rows still shipped_back_to_us)

const bulkSelect = $('bulkStatus');
const btnApply   = $('applyBulkStatus');
const g = String(grp?.status || '').toLowerCase().replace(/\s+/g,'');


// Always show these five statuses (hide only when the group is Closed)
const PHASE_OPTIONS = (g === 'closed')
  ? []
  : [
      ['shipped_to_psa',    'Ship to PSA'],
      ['in_grading',        'In grading'],
      ['graded',            'Graded'],
      ['shipped_back_to_us','Shipped Back to Us'],
      ['received_from_psa', 'Received from PSA'],
    ];


// Populate dropdown
if (bulkSelect) {
  if (PHASE_OPTIONS.length) {
    bulkSelect.innerHTML =
      `<option value="">— Select a status —</option>` +
      PHASE_OPTIONS.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('');
    btnApply.disabled = true;
  } else {
    bulkSelect.innerHTML = `<option value="">— No bulk actions —</option>`;
    btnApply.disabled = true;
  }
}

// Show/hide the wrapper based on whether there are options
updateBulkStatusVisibility(g, PHASE_OPTIONS.length > 0);

// Enable Apply only when a value is chosen
bulkSelect?.addEventListener('change', () => {
  btnApply.disabled = !bulkSelect.value;
});


// Apply handler (only two values possible by construction)
btnApply?.addEventListener('click', async () => {
  const value = bulkSelect.value; // 'shipped_back_to_us' OR 'received_from_psa'
  if (!value) return;

  btnApply.disabled = true;
  btnApply.textContent = 'Applying…';
  try {
    const res = await fetch('/api/admin/groups.set-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        status: value,
        group_id: String(grp?.id || id),
      })
    });

    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok !== true) throw new Error(j.error || 'Failed to update status');

    // After receiving from PSA, lock bulk in Returned
    if (value === 'received_from_psa') {
      updateBulkStatusVisibility('Returned', false);
    }

    await renderDetail(root, id, codeOut);
  } catch (err) {
    alert(err.message || 'Failed to update status');
    btnApply.disabled = false;
    btnApply.textContent = 'Apply';
    return;
  }
});


// --- Step C: Edit / Save / Cancel for Card order ---
const btnEdit   = $('btnEditOrder');
const btnSave   = $('btnSaveOrder');
const btnCancel = $('btnCancelOrder');
const tableEl   = $box?.querySelector('table.data-table');
const tbodyEl   = tableEl?.querySelector('tbody');

// --- Row-status edit buffer (Step 1: UI only; Step 2 will save) ---
const pending = new Map(); // key=cardId -> { cardId, submissionId, from, to }
const btnSaveStatuses = $('btnSaveStatuses');

      // ---------- Modal (clean custom prompt) ----------
function ensureModalStyles(){
  if (document.getElementById('psa-modal-styles')) return;
  const css = `
    .psa-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center}
    .psa-modal{background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.2);max-width:560px;width:92%;padding:18px}
    .psa-modal h3{margin:0 0 8px 0;font-size:18px}
    .psa-modal .body{font-size:14px;color:#333}
    .psa-modal .row{padding:10px 0;border-top:1px solid #eee}
    .psa-modal .row:first-child{border-top:none}
    .psa-modal .subhead{font-weight:600}
    .psa-modal .choices{margin-top:6px;display:flex;gap:16px;align-items:center}
    .psa-modal .actions{margin-top:14px;display:flex;gap:8px;justify-content:flex-end}
    .psa-btn{border:1px solid #d0d7de;border-radius:8px;background:#fff;padding:8px 12px;font:inherit;cursor:pointer}
    .psa-btn.primary{background:#0b5cff;border-color:#0b5cff;color:#fff}
    .psa-btn:disabled{opacity:.6;cursor:not-allowed}
  `;
  const style = document.createElement('style');
  style.id = 'psa-modal-styles';
  style.textContent = css;
  document.head.appendChild(style);
}
function confirmScopes(subInfos){
  // subInfos: [{subId, subLabel, total, changed, uniformTo, changedCardIds}]
  ensureModalStyles();
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'psa-modal-backdrop';
    wrap.innerHTML = `
      <div class="psa-modal" role="dialog" aria-modal="true">
        <h3>Apply status changes</h3>
        <div class="body">
          ${subInfos.map((s,i)=>`
            <div class="row" data-sub="${s.subId}">
              <div class="subhead">${s.subLabel} — ${s.total} card${s.total===1?'':'s'} in this group</div>
              <div class="choices">
                <label><input type="radio" name="scope-${i}" value="changed" checked> Only the changed card${s.changed===1?'':'s'} (${s.changed})</label>
                <label><input type="radio" name="scope-${i}" value="all" ${s.uniformTo ? '' : 'disabled'}> All ${s.total} cards in this submission</label>
              </div>
              ${!s.uniformTo ? `<div class="note" style="color:#a00;margin-top:4px">Multiple different targets selected for this submission — update “All” is disabled.</div>`:''}
            </div>
          `).join('')}
          <div class="actions">
            <button class="psa-btn" id="m-cancel">Cancel</button>
            <button class="psa-btn primary" id="m-apply">Apply</button>
          </div>
        </div>
      </div>`;
    const getChoiceMap = () => {
      const out = new Map();
      subInfos.forEach((s,i)=>{
        const val = wrap.querySelector(`input[name="scope-${i}"]:checked`)?.value || 'changed';
        out.set(s.subId, val);
      });
      return out;
    };
    wrap.querySelector('#m-cancel').onclick = ()=>{ document.body.removeChild(wrap); resolve(null); };
    wrap.querySelector('#m-apply').onclick  = ()=>{ const m=getChoiceMap(); document.body.removeChild(wrap); resolve(m); };
    document.body.appendChild(wrap);
  });
}
// Small helper: nice label for a submission id/code
const subLabel = (sid) => subById.get(String(sid))?.code || String(sid);

// ---------- Save statuses with scope prompt ----------
async function saveRowStatuses(){
  if (!pending.size) return;

  // Build per-submission stats
  const changes = Array.from(pending.values()); // {cardId, submissionId, from, to}
  const bySub = new Map();
  for (const ch of changes) {
    const key = String(ch.submissionId);
    if (!bySub.has(key)) bySub.set(key, { subId: key, targets: new Set(), changedCardIds: [] });
    const entry = bySub.get(key);
    entry.targets.add(ch.to);
    entry.changedCardIds.push(ch.cardId);
  }
  // For each submission, how many cards exist in this group?
  const subInfos = Array.from(bySub.values()).map(e => {
    const total = rowsData.filter(r => String(r.submission_id) === e.subId).length;
    return {
      subId: e.subId,
      subLabel: subLabel(e.subId),
      total,
      changed: e.changedCardIds.length,
      uniformTo: (e.targets.size === 1),     // only allow “All” when the target is the same
      to: Array.from(e.targets)[0] || null,
      changedCardIds: e.changedCardIds
    };
  });

  // If any submission has more cards than we changed, show the modal
  let scopeChoice = new Map(subInfos.map(s => [s.subId, 'changed']));
  const needsPrompt = subInfos.some(s => s.total > s.changed);
  if (needsPrompt) {
    const picked = await confirmScopes(subInfos);
    if (!picked) return; // cancelled
    scopeChoice = picked;
  }

  // Build API jobs
  const jobsSub = [];  // {submission_id, status}
  const jobsCard = []; // {card_id, status}
  for (const s of subInfos) {
    const choice = scopeChoice.get(s.subId) || 'changed';
    if (choice === 'all') {
      if (!s.uniformTo || !s.to) continue; // safety
      jobsSub.push({ submission_id: s.subId, status: s.to });
    } else {
      // only the explicitly edited cards in this submission
      for (const ch of changes.filter(c => String(c.submissionId) === s.subId)) {
        jobsCard.push({ card_id: ch.cardId, status: ch.to });
      }
    }
  }

  // Disable UI during save
  btnSaveStatuses.disabled = true;
  btnSaveStatuses.textContent = 'Saving…';

  try {
    // 1) Update whole submissions
    for (const j of jobsSub) {
      const r = await fetch('/api/admin/submissions.set-status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ submission_id: j.submission_id, status: j.status })
      });
      const jj = await r.json().catch(()=>({}));
      if (!r.ok || jj.ok !== true) throw new Error(jj.error || `Failed to update ${j.submission_id}`);
    }

    // 2) Update individual cards (if your API path differs, adjust here)
    for (const j of jobsCard) {
      const r = await fetch('/api/admin/cards.set-status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ card_id: j.card_id, status: j.status })
      });
      const jj = await r.json().catch(()=>({}));
      if (!r.ok || jj.ok !== true) throw new Error(jj.error || `Failed to update card ${j.card_id}`);
    }

    // Success → refresh detail
    await renderDetail(root, id, codeOut);
  } catch (err) {
    alert(err.message || 'Failed to save status changes');
    btnSaveStatuses.disabled = false;
    btnSaveStatuses.textContent = 'Save status changes';
  }
}

// Replace the temporary console stub:
btnSaveStatuses?.removeEventListener?.('__temp', ()=>{});
btnSaveStatuses?.addEventListener('click', saveRowStatuses);


function setStatusSaveEnabled(){
  if (btnSaveStatuses) btnSaveStatuses.disabled = pending.size === 0;
}

// Track dropdown changes, enable Save button
tbodyEl?.addEventListener('change', (e) => {
  const sel = e.target?.closest?.('select.row-status');
  if (!sel) return;

  const cardId = sel.dataset.cardId;
  const sid    = sel.dataset.sid;
  const to     = sel.value;

  // figure out current "from" using our effective resolver
  const rowObj = rowsData.find(r => String(r.id) === String(cardId)) || {};
  const from   = effectiveRowStatus(rowObj) || 'received_from_psa';

  // mark dirty in UI
  sel.classList.add('dirty');

  pending.set(String(cardId), { cardId, submissionId: sid, from, to });
  setStatusSaveEnabled();
});

// Temporary stub for Step 1: just log pending changes.
// (In Step 2 we’ll implement modal + API calls.)
btnSaveStatuses?.addEventListener('click', () => {
  console.log('Pending status changes (Step 1):', Array.from(pending.values()));
});

// use uuid if present, else code (both are accepted by your API)
const groupKey = (grp?.id || grp?.code || id);

// Helpers
const rowsSel = 'tr[data-card-id]';
const by = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const getOrder = () =>
  by(rowsSel, tbodyEl).map(tr => tr.getAttribute('data-card-id')).filter(Boolean);

function enableSave() {
  if (btnSave) btnSave.disabled = false;
}

function refreshVisibleNumbers() {
  // re-number Card # column 1..N in DOM order
  const ths = [...tableEl.querySelectorAll('thead th')].map(th => th.textContent.trim().toLowerCase());
  let cardNoColIdx = ths.findIndex(t => t === 'card #');
  if (cardNoColIdx < 0) cardNoColIdx = 3; // fallback if label changed
  const tdSelector = `td:nth-child(${cardNoColIdx + 1})`;

  by(rowsSel, tbodyEl).forEach((tr, i) => {
    const td = tr.querySelector(tdSelector);
    if (!td) return;
    const label = td.querySelector('.ord-index');
    if (label) label.textContent = String(i + 1);
  });
}

function moveRow(tr, dir) {
  if (!tr || !tbodyEl) return;
  if (dir < 0) {
    const prev = tr.previousElementSibling;
    if (prev) tbodyEl.insertBefore(tr, prev);
  } else if (dir > 0) {
    const next = tr.nextElementSibling;
    if (next) tbodyEl.insertBefore(next, tr);
  }
  refreshVisibleNumbers();
  enableSave();
}

function wireDnD() {
  if (!tbodyEl) return;

  let dragging = null;

  by('.drag-handle', tbodyEl).forEach(handle => {
    handle.setAttribute('draggable', 'true');

    handle.addEventListener('dragstart', (e) => {
      const tr = e.target.closest('tr');
      dragging = tr;
      tr.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', tr.getAttribute('data-card-id') || ''); } catch {}
      e.dataTransfer.effectAllowed = 'move';
    });

    handle.addEventListener('dragend', () => {
      if (dragging) dragging.classList.remove('dragging');
      dragging = null;
      by(rowsSel, tbodyEl).forEach(r => r.classList.remove('drop-above', 'drop-below'));
    });
  });

  tbodyEl.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const overTr = e.target.closest('tr');
    if (!overTr || overTr === dragging) return;

    // decide before/after using mouse Y
    const rect = overTr.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;

    by(rowsSel, tbodyEl).forEach(r => r.classList.remove('drop-above', 'drop-below'));
    overTr.classList.add(before ? 'drop-above' : 'drop-below');
  });

  tbodyEl.addEventListener('drop', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const overTr = e.target.closest('tr');
    if (!overTr || overTr === dragging) return;

    const before = overTr.classList.contains('drop-above');
    overTr.classList.remove('drop-above', 'drop-below');

    if (before) {
      tbodyEl.insertBefore(dragging, overTr);
    } else {
      const next = overTr.nextElementSibling;
      if (next) tbodyEl.insertBefore(dragging, next);
      else tbodyEl.appendChild(dragging);
    }

    dragging.classList.remove('dragging');
    dragging = null;
    refreshVisibleNumbers();
    enableSave();
  });
}

function enterEditMode() {
  if (!tbodyEl) return;

  btnEdit.style.display = 'none';
  btnSave.style.display = '';
  btnCancel.style.display = '';
  btnSave.disabled = true;

  // Find Card # column robustly
  const ths = [...tableEl.querySelectorAll('thead th')].map(th => th.textContent.trim().toLowerCase());
  let cardNoColIdx = ths.findIndex(t => t === 'card #');
  if (cardNoColIdx < 0) cardNoColIdx = 3; // fallback to 4th col
  const tdSelector = `td:nth-child(${cardNoColIdx + 1})`;

  // Replace Card # cells with controls: [▲] [handle] [▼] + live index
  by(rowsSel, tbodyEl).forEach((tr, i) => {
    const td = tr.querySelector(tdSelector);
    if (!td) return;
    td.innerHTML = `
  <div class="order-cell">
    <button type="button" class="order-btn up" title="Move up">▲</button>
    <span class="drag-handle" tabindex="0" role="button" aria-label="Drag to reorder"></span>
    <button type="button" class="order-btn down" title="Move down">▼</button>
    <span class="ord-index">${i + 1}</span>
  </div>
`;

  });

  // Up/Down clicks
  tbodyEl.addEventListener('click', (e) => {
    const up = e.target.closest('.order-btn.up');
    const down = e.target.closest('.order-btn.down');
    if (up || down) {
      const tr = e.target.closest('tr');
      moveRow(tr, up ? -1 : 1);
    }
  });

  // Keyboard: ArrowUp/ArrowDown on handle moves row
  tbodyEl.addEventListener('keydown', (e) => {
    if (!e.target.closest('.drag-handle')) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); moveRow(e.target.closest('tr'), -1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveRow(e.target.closest('tr'),  1); }
  });

  // Drag & drop
  wireDnD();
}

async function saveOrder() {
  if (!tbodyEl) return;

  const seen = new Set();
  const order = [];
  for (const tr of by(rowsSel, tbodyEl)) {
    const id = tr.getAttribute('data-card-id');
    if (id && !seen.has(id)) { seen.add(id); order.push(id); }
  }
  if (!order.length) {
    alert('No cards to reorder.');
    return;
  }

  btnSave.disabled = true;
  btnEdit.disabled = true;
  btnCancel.disabled = true;

  try {
    const res = await fetch(`/api/admin/groups/${encodeURIComponent(groupKey)}/cards/order`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ order })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok !== true) throw new Error(j.error || 'Reorder failed');

    // Re-render fresh (server will normalize 1..N)
    renderDetail(root, id, codeOut);
  } catch (err) {
    alert(err.message || 'Reorder failed');
    btnSave.disabled = false;
    btnEdit.disabled  = false;
    btnCancel.disabled = false;
  }
}

function cancelEdit() {
  renderDetail(root, id, codeOut); // reload read-only view
}

btnEdit?.addEventListener('click', enterEditMode);
btnSave?.addEventListener('click', saveOrder);
btnCancel?.addEventListener('click', cancelEdit);

    }
  } catch (e) {
    if ($box) $box.innerHTML = `<div class="note">Error loading group: ${escapeHtml(e.message || 'Unknown error')}</div>`;
  }
}

// ===== Boot for Groups page =====
function bootGroupsPage(){
  ensureSignoutWired();
  wireSidebarNav();

  const authed = /(?:^|;\s*)psa_admin=/.test(document.cookie);
  const loginEl = document.getElementById('login');
  const shellEl = document.getElementById('shell');

  const authNote = document.getElementById('auth-note');
  if (authNote) authNote.textContent = authed ? 'passcode session' : 'not signed in';
  const authNoteTop = document.getElementById('auth-note-top');
  if (authNoteTop) authNoteTop.textContent = authed ? 'passcode session' : 'not signed in';

  // Groups page is read-only and behind pass cookie the same as /admin
  if (authed) {
    if (loginEl) loginEl.classList.add('hide');
    if (shellEl) shellEl.classList.remove('hide');
    showGroupsView();
    wireDeleteButtonOnce();
    enableDelete(false);
  } else {
    window.location.replace('/admin');
  }
}

document.addEventListener('DOMContentLoaded', bootGroupsPage);
