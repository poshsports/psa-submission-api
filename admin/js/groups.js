import { $, debounce, escapeHtml, prettyStatus } from './util.js';
import { fetchGroups, logout, deleteGroup } from './api.js';

// Post-PSA progression (used in multiple places)
const POST_PSA_ORDER = [
  'received_from_psa',
  'balance_due',
  'paid',
  'shipped_to_customer',
  'delivered',
];
// Pre-PSA progression (submission-driven display)
const PRE_PSA_ORDER = [
  'pending_payment','submitted','submitted_paid','received',
  'shipped_to_psa','in_grading','graded'
];

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

let scrollerWired = false;

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
if (!scrollerWired) {
  window.addEventListener('resize', ensureScroller, { passive: true });
  scrollerWired = true;
}



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
  
// UUID helper used when building payloads:
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (s) => UUID_RE.test(String(s || '').trim());

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

// Map submissions for quick lookup by id OR by code
const subById   = new Map(submissions.map(s => [String(s.id), s]));
const subByCode = new Map(submissions.map(s => [String(s.code), s]));

const POST_PSA_SET = new Set(POST_PSA_ORDER);
const PRE_PSA_SET  = new Set(PRE_PSA_ORDER);
const SUB_DOMINATES_SET = new Set([
  'balance_due',
  'paid',
  'shipped_to_customer',
  'delivered',
]);

// Which status should a row *show*?
// • Pre-PSA: always show the submission status (reflects bulk updates immediately).
// • At the handoff ("received_from_psa"): prefer a post-PSA card status if present.
// • Post-PSA: certain submission statuses dominate; otherwise show any post-PSA card status.
function effectiveRowStatus(cardRow) {
  const rawSid = String(cardRow.submission_id || '');
  const subRec = subById.get(rawSid) || subByCode.get(rawSid);

  const sSub  = String(subRec?.status ?? '').toLowerCase();
  const sCard = String(cardRow.status ?? '').toLowerCase();

  // Before the return, the submission drives the display
  if (PRE_PSA_SET.has(sSub)) return sSub || sCard || '';

  // At the handoff, prefer a card's post-PSA value if it exists
  if (sSub === 'received_from_psa') {
    return POST_PSA_SET.has(sCard) ? sCard : sSub;
  }

  // After return, these submission values dominate regardless of card status
  if (SUB_DOMINATES_SET.has(sSub)) return sSub;

  // Otherwise, prefer any post-PSA card status
  if (POST_PSA_SET.has(sCard)) return sCard;

  // Fallback
  return sSub || sCard || '';
}


const CARD_COLS = [
  { label: 'Created',    fmt: (c) => safe(c._created_on || '') },

  { label: 'Submission', fmt: (c) => {
      const raw = String(c.submission_id || '');
      const sub = subById.get(raw) || subByCode.get(raw);
      return safe(sub?.code || raw);
    }
  },

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

  // ===== Status (UUID in data-sid, human code in data-scode) =====
  {
    label: 'Status',
    fmt: (c) => {
      const rawSid  = String(c.submission_id || '');
      const subRec  = subById.get(rawSid) || subByCode.get(rawSid) || {};

      const pickUuid = (v) => {
        const s = String(v || '').trim();
        return UUID_RE.test(s) ? s : '';
      };

      const sid =
        pickUuid(subRec.id) ||
        pickUuid(subRec.uuid) ||
        pickUuid(subRec.submission_id) ||
        '';

      const scode = String(subRec.code || rawSid || '');

      const eff = effectiveRowStatus(c) || 'received_from_psa';
      const showSelect = POST_PSA_SET.has(eff);

      if ((!sid && !scode) || !showSelect) {
        return eff ? escapeHtml(prettyStatus(eff)) : '—';
      }

      const options = POST_PSA_ORDER.map(v => {
        const sel = (v === eff) ? 'selected' : '';
        return `<option value="${v}" ${sel}>${escapeHtml(prettyStatus(v))}</option>`;
      }).join('');

      const rowKey = (c.id != null && c.id !== '') ? String(c.id) : `sub-${c.submission_id}`;

      return `
        <select class="row-status"
                data-sid="${escapeHtml(sid)}"
                data-scode="${escapeHtml(scode)}"
                data-card-id="${escapeHtml(rowKey)}">
          ${options}
        </select>
      `;
    },
  },

  {
    label: 'Service',
    fmt: (c) => {
      const raw = String(c.submission_id || '');
      const sub = subById.get(raw) || subByCode.get(raw);
      return safe(c.grading_service || sub?.grading_service || '');
    },
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
          const sub = (subById.get(sid) || subByCode.get(sid) || {});
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
    <thead>
      <tr>${CARD_COLS.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr>
    </thead>
    <tbody>
      ${
        rowsData.length
          ? rowsData.map(r => {
              // Row key: real card id if present, else synthetic per submission
              const rowKey = (r.id != null && r.id !== '') ? String(r.id) : `sub-${r.submission_id}`;
              return `
                <tr data-card-id="${escapeHtml(rowKey)}">
                  ${CARD_COLS.map(col => `<td>${col.fmt(r)}</td>`).join('')}
                </tr>
              `;
            }).join('')
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


const gPhase = String(grp?.status || '').toLowerCase().replace(/\s+/g,'');
const anyShippedBack = rowsData.some(r => (effectiveRowStatus(r) === 'shipped_back_to_us'));

let PHASE_OPTIONS = [];
if (gPhase === 'atpsa') {
  PHASE_OPTIONS = [
    ['shipped_back_to_us','Shipped Back to Us'],
    ['received_from_psa','Received from PSA'],
  ];
} else if (gPhase === 'returned' && anyShippedBack) {
  PHASE_OPTIONS = [['received_from_psa','Received from PSA']];
}



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
updateBulkStatusVisibility(grp?.status, PHASE_OPTIONS.length > 0);

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

  // 👇 Debug info from the API (helps us verify submission/card selection on the server)
  if (j.debug) console.log('groups.set-status debug:', j.debug);

  // Update the group header immediately (optional; we also re-fetch right after)
  if (j.group?.status) {
    const statusEl = root.querySelector('.card .note + div'); // the "Status" value cell
    if (statusEl) statusEl.textContent = j.group.status;
  }

  // If we just marked "Received from PSA", hide bulk in Returned
  if (value === 'received_from_psa') updateBulkStatusVisibility('Returned', false);

  // Always refresh the detail view to pull updated rows
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

// --- Row-status edit buffer (always update whole submission) ---
const pending = new Map(); // cardId -> { cardId, submissionId, from, to }
const btnSaveStatuses = $('btnSaveStatuses');

const idxOf = (s) => POST_PSA_ORDER.indexOf(String(s || '').toLowerCase());

function setStatusSaveEnabled(){
  if (btnSaveStatuses) btnSaveStatuses.disabled = pending.size === 0;
}

// Track dropdown changes
tbodyEl?.addEventListener('change', (e) => {
  const sel = e.target?.closest?.('select.row-status');
  if (!sel) return;

  const cardId = sel.dataset.cardId;
  const sid    = sel.dataset.sid;
  const scode  = sel.dataset.scode || '';
  const to     = sel.value;
  if (!sid && !scode) return;

  const rowObj = rowsData.find(r =>
  String(r.id ?? `sub-${r.submission_id}`) === String(cardId)
) || {};
  const from   = effectiveRowStatus(rowObj) || 'received_from_psa';

  sel.classList.add('dirty');
  pending.set(String(cardId), { cardId, submissionId: sid, submissionCode: scode, from, to });
  setStatusSaveEnabled();
});

const subLabel = (sid) => {
  const s = subById.get(String(sid)) || subByCode.get(String(sid));
  return s?.code || String(sid);
};

async function saveRowStatuses() {
  if (!pending.size) return;

  const targets = new Map(); // key -> { subId, subCode, to }
  for (const { submissionId, submissionCode, to } of pending.values()) {
    const key = String(submissionId || submissionCode);
    const prev = targets.get(key);
    if (!prev || idxOf(to) > idxOf(prev.to)) {
      targets.set(key, { subId: submissionId, subCode: submissionCode, to });
    }
  }

  btnSaveStatuses.disabled = true;
  btnSaveStatuses.textContent = 'Saving…';

  try {
    for (const { subId, subCode, to } of targets.values()) {
      // Try to recover identifiers if one is blank
      let id   = isUuid(subId) ? subId : '';
      let code = subCode || '';

      if (!id || !code) {
        // Look up by whatever we have
        const rec =
          subById.get(subId || '') ||
          subByCode.get(subCode || '') ||
          subById.get(subCode || '') ||   // in case subId actually held a code
          subByCode.get(subId || '');

        if (rec) {
          if (!id)   id   = isUuid(rec.id) ? rec.id : '';
          if (!code) code = rec.code || '';
        }
      }

      // As a last resort, if we only have one, mirror it into the other field
      if (!code && subId && !isUuid(subId)) code = subId; // human code ended up in subId
      if (!id && isUuid(subCode)) id = subCode;            // unlikely, but safe

      const body = { status: to, cascade_cards: true };
      if (id)   body.submission_id   = id;   // UUID only
      if (code) body.submission_code = code; // always include code if we have it

      if (!body.submission_id && !body.submission_code) {
        throw new Error('Missing submission identifier');
      }

      console.log('submissions.set-status →', body);
      const r = await fetch('/api/admin/submissions.set-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body)
      });
      const jj = await r.json().catch(() => ({}));
      if (!r.ok || jj.ok !== true) throw new Error(jj.error || 'Failed to update');
    }

    pending.clear();
    btnSaveStatuses.disabled = true;
    btnSaveStatuses.textContent = 'Save status changes';
    await renderDetail(root, id, codeOut);
  } catch (err) {
    alert(err.message || 'Failed to save status changes');
    btnSaveStatuses.disabled = false;
    btnSaveStatuses.textContent = 'Save status changes';
  }
}



btnSaveStatuses?.addEventListener('click', saveRowStatuses);


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
