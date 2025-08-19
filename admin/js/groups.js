// /admin/js/groups.js
// Minimal read-only Groups list view.
// Renders a table with Code, Status, Count, Shipped, Returned, Updated.
// Click a row logs the group id (we'll hook detail next step).

import { $, escapeHtml } from './util.js';
import { fetchGroups } from './api.js';

function fmt(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch { return String(ts); }
}

function ensureContainer() {
  // Create a simple container if not present (keeps this step self-contained)
  let root = $('view-groups');
  if (!root) {
    root = document.createElement('div');
    root.id = 'view-groups';
    root.style.padding = '12px';
    // Hide by default; your app can toggle .hide on sections as needed
    root.className = '';
    document.body.appendChild(root);
  }
  return root;
}

export async function showGroupsView() {
  const root = ensureContainer();
  root.innerHTML = `<div>Loading groups…</div>`;

  let resp;
  try {
    resp = await fetchGroups({ limit: 50, offset: 0 });
  } catch (e) {
    root.innerHTML = `<div style="color:#b91c1c">Failed to load groups: ${escapeHtml(e?.message || 'error')}</div>`;
    return;
  }

  const items = Array.isArray(resp?.items) ? resp.items : [];

  if (!items.length) {
    root.innerHTML = `<div>No groups yet.</div>`;
    return;
  }

  const rows = items.map(g => {
    const code = escapeHtml(g.code || '');
    const status = escapeHtml(g.status || '');
    const notes = escapeHtml(g.notes || '');
    const cnt = Number.isFinite(g.submission_count) ? g.submission_count : '';
    const shipped = fmt(g.shipped_at);
    const returned = fmt(g.returned_at);
    const updated = fmt(g.updated_at);
    const id = escapeHtml(g.id || '');

    return `
      <tr data-id="${id}" class="grp-row" style="cursor:pointer">
        <td style="padding:8px 10px">${code}</td>
        <td style="padding:8px 10px">${status}</td>
        <td style="padding:8px 10px;text-align:right">${cnt}</td>
        <td style="padding:8px 10px">${shipped}</td>
        <td style="padding:8px 10px">${returned}</td>
        <td style="padding:8px 10px">${updated}</td>
        <td style="padding:8px 10px;color:#64748b">${notes}</td>
      </tr>
    `;
  }).join('');

  root.innerHTML = `
    <h2 style="margin:0 0 10px">Groups</h2>
    <div class="note" style="margin:0 0 12px;color:#64748b">Read-only for now. Click a row to load details (hook comes next).</div>
    <div style="overflow:auto;border:1px solid #eee;border-radius:8px;background:#fff">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead style="background:#fafafa;border-bottom:1px solid #eee">
          <tr>
            <th style="text-align:left;padding:8px 10px">Code</th>
            <th style="text-align:left;padding:8px 10px">Status</th>
            <th style="text-align:right;padding:8px 10px">Count</th>
            <th style="text-align:left;padding:8px 10px">Shipped</th>
            <th style="text-align:left;padding:8px 10px">Returned</th>
            <th style="text-align:left;padding:8px 10px">Updated</th>
            <th style="text-align:left;padding:8px 10px">Notes</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  // Row click handler – for now just console.log; next step will open a detail view/drawer
  root.querySelectorAll('tr.grp-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const id = tr.getAttribute('data-id');
      console.log('[Groups] row click id=', id);
      // Next step: we'll call fetchGroup(id) and render members in a drawer/modal.
    });
  });
}
