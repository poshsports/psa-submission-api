// /admin/js/billing.columns.js
import { escapeHtml } from './util.js';

/* helpers */
const esc = (s) => escapeHtml(String(s ?? ''));
const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toLocaleString();
};
const countPill = (count, title) =>
  `<span class="pill" title="${esc(title || '')}">${esc(String(count))}</span>`;
const chip = (text) => `<span class="pill" title="${esc(text)}">${esc(text)}</span>`;

/**
 * Columns for the Billing table
 * Keep columns that don't map to a real row property as non-sortable.
 * Sorting is handled by billing.table.js which expects actual keys on the row.
 */
export const COLUMNS = [
  // Customer (use email, single-line with tooltip)
  {
    key: 'customer',
    label: 'Customer',
    sortable: false,
    format: (_val, r) => {
      const email = (r.customer_email || r.customer || '').trim();
      const name = (r.customer_name || '').trim();
      const display = email || name || '—';
      return `<span title="${esc(email || name)}">${esc(display)}</span>`;
    },
  },

  // Submissions: single chip if 1; otherwise count with hover list
  {
    key: 'submissions',
    label: 'Submissions',
    sortable: false,
    format: (_val, r) => {
      const ids = Array.isArray(r.submissions)
        ? r.submissions.map((s) => s?.submission_id).filter(Boolean)
        : [];
      if (ids.length === 1) return chip(ids[0]);
      if (ids.length > 1) return countPill(ids.length, ids.join(', '));
      return '0';
    },
  },

  // Groups: single chip if 1; otherwise count with hover list
  {
    key: 'groups',
    label: 'Groups',
    sortable: false,
    format: (_val, r) => {
      const gs = Array.isArray(r.groups) ? r.groups.filter(Boolean) : [];
      if (gs.length === 1) return chip(gs[0]);
      if (gs.length > 1) return countPill(gs.length, gs.join(', '));
      return '—';
    },
  },

  // Cards: total cards across all submissions (always single-line)
  {
    key: 'cards',
    label: 'Cards',
    sortable: true, // numeric sort is supported in billing.table.js
    format: (_val, r) => {
      const total =
        Number(r.cards) ||
        (Array.isArray(r.submissions)
          ? r.submissions.reduce((a, s) => a + (Number(s?.cards) || 0), 0)
          : 0);
      return `<span title="${esc(String(total))}">${esc(String(total))}</span>`;
    },
  },

  // Returned: newest 'received_from_psa' timestamp
  {
    key: 'returned',
    label: 'Returned',
    sortable: true, // billing.table.js has special handling for 'returned'
    format: (_val, r) => fmtDateTime(r.returned_newest || r.returned),
  },

  // Age (days): based on oldest 'received_from_psa'
  {
    key: 'age_days',
    label: 'Age (days)',
    sortable: true, // numeric
    format: (_val, r) => (r.age_days == null ? '—' : String(r.age_days)),
  },

  // Est. Total: placeholder (no inline preview button here)
  {
    key: 'est_total',
    label: 'Est. Total',
    sortable: false,
    format: () => '—',
  },

  // Actions: only "Create Draft"
  {
    key: 'actions',
    label: 'Actions',
    sortable: false,
    format: (_val, r) => {
      // Keep it simple for now; wiring to open the overlay happens elsewhere
      // (e.g., click handler in billing.app.js using `.js-open-draft`).
      const safeBundle = esc(
        JSON.stringify({
          customer_email: r.customer_email,
          customer_name: r.customer_name,
          submissions: r.submissions,
          groups: r.groups,
          cards: r.cards,
          returned_newest: r.returned_newest,
          returned_oldest: r.returned_oldest,
        })
      );
      return `<button type="button" class="btn small js-open-draft" data-bundle="${safeBundle}">Create Draft</button>`;
    },
  },
];
