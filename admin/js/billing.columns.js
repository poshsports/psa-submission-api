// /admin/js/billing.columns.js
import { escapeHtml } from './util.js';

/* helpers */
const fmtMoney = (cents) =>
  Number.isFinite(cents) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100) : '—';
const fmtCurrencyFromCents = (cents) => {
  const n = Number(cents);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2
  }).format(n / 100);
};

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

/** Build the "Create Draft" button the table-click handler listens for */
function actionsButton(row) {
  const email = (row.customer_email || row.customer || '').trim().toLowerCase();
  const ids = Array.isArray(row.submissions)
    ? row.submissions.map(s => s?.submission_id).filter(Boolean)
    : [];
  // handler will decode this if needed; keep email plain
  const subsCsv = ids.join(',');
  const subsAttr = encodeURIComponent(subsCsv);

  return `
    <button type="button"
            class="btn small"
            data-action="draft"
            data-email="${esc(email)}"
            data-subs="${subsAttr}">
      Create Draft
    </button>
  `;
}

/**
 * Columns for the Billing table
 * Keep columns that don't map to a real row property as non-sortable.
 */
export const COLUMNS = [
  // Customer - show email (not truncated unless very long) with full tooltip
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

  // Submissions: 1 -> chip with id; many -> count pill with hover listing
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

  // Groups: 1 -> chip; many -> count pill with hover listing
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

  // Cards: total across submissions
  {
    key: 'cards',
    label: 'Cards',
    sortable: true,
    format: (_val, r) => {
      const total =
        Number(r.cards) ||
        (Array.isArray(r.submissions)
          ? r.submissions.reduce((a, s) => a + (Number(s?.cards) || 0), 0)
          : 0);
      return `<span title="${esc(String(total))}">${esc(String(total))}</span>`;
    },
  },

  // Returned: newest 'received_from_psa'
  {
    key: 'returned',
    label: 'Returned',
    sortable: true,
    format: (_val, r) => fmtDateTime(r.returned_newest || r.returned),
  },

  // Age (days): based on oldest 'received_from_psa'
  {
    key: 'age_days',
    label: 'Age (days)',
    sortable: true,
    format: (_val, r) => (r.age_days == null ? '—' : String(r.age_days)),
  },

  // Est. Total: placeholder for now (no preview button here)
{
  key: 'est_total',
  label: 'Est. Total',
  sortable: true,
  align: 'right',
  format: (_val, r) => {
    const cents = Number.isFinite(r.est_total_cents) ? r.est_total_cents
                  : Number.isFinite(r.est_total)      ? r.est_total
                  : null;
    return fmtMoney(cents);
  },
},


  // Actions: single "Create Draft" button
  {
    key: 'actions',
    label: 'Actions',
    sortable: false,
    format: (_val, r) => actionsButton(r),
  },
];
