import { useEffect, useState } from 'react';

type GroupRow = {
  id: string;
  code: string;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  shipped_at: string | null;
  returned_at: string | null;
  submission_count: number;
};

export default function GroupsPage() {
  const [status, setStatus] = useState<string>('');
  const [q, setQ] = useState<string>('');
  const [limit, setLimit] = useState<number>(50);
  const [offset, setOffset] = useState<number>(0);
  const [rows, setRows] = useState<GroupRow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const u = new URL('/api/admin/groups', window.location.origin);
      u.searchParams.set('status', status);
      u.searchParams.set('q', q);
      u.searchParams.set('limit', String(limit));
      u.searchParams.set('offset', String(offset));

      const res = await fetch(u.toString());
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Request failed');
      setRows(data || []);
    } catch (e: any) {
      setErr(e.message || String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* initial load */ }, []); // eslint-disable-line

  return (
    <div style={{ padding: 20, fontFamily: 'system-ui, Arial' }}>
      <h1>Groups</h1>

      <form
        onSubmit={(e) => { e.preventDefault(); setOffset(0); load(); }}
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px 100px 140px', gap: 8, marginBottom: 16 }}
      >
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">(any status)</option>
          <option>Draft</option>
          <option>ReadyToShip</option>
          <option>InTransit</option>
          <option>AtPSA</option>
          <option>Returned</option>
          <option>Closed</option>
        </select>

        <input
          placeholder="Search code/notes…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />

        <input
          type="number"
          min={1}
          max={200}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          title="limit"
        />

        <input
          type="number"
          min={0}
          value={offset}
          onChange={(e) => setOffset(Number(e.target.value))}
          title="offset"
        />

        <button type="submit" disabled={loading}>
          {loading ? 'Loading…' : 'Search'}
        </button>
      </form>

      {err && <div style={{ color: 'crimson', marginBottom: 12 }}>Error: {err}</div>}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
            <th style={{ padding: '6px 4px' }}>Code</th>
            <th style={{ padding: '6px 4px' }}>Status</th>
            <th style={{ padding: '6px 4px' }}>Submissions</th>
            <th style={{ padding: '6px 4px' }}>Created</th>
            <th style={{ padding: '6px 4px' }}>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
              <td style={{ padding: '6px 4px', fontWeight: 600 }}>{r.code}</td>
              <td style={{ padding: '6px 4px' }}>{r.status}</td>
              <td style={{ padding: '6px 4px' }}>{r.submission_count}</td>
              <td style={{ padding: '6px 4px' }}>{new Date(r.created_at).toLocaleString()}</td>
              <td style={{ padding: '6px 4px' }}>{new Date(r.updated_at).toLocaleString()}</td>
            </tr>
          ))}
          {!loading && rows.length === 0 && (
            <tr><td colSpan={5} style={{ padding: 12, color: '#666' }}>No groups found.</td></tr>
          )}
        </tbody>
      </table>

      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button
          onClick={() => { const n = Math.max(0, offset - limit); setOffset(n); setTimeout(load, 0); }}
          disabled={loading || offset === 0}
        >
          ◀ Prev
        </button>
        <button
          onClick={() => { const n = offset + limit; setOffset(n); setTimeout(load, 0); }}
          disabled={loading || rows.length < limit}
        >
          Next ▶
        </button>
        <span style={{ color: '#666' }}>offset: {offset}</span>
      </div>
    </div>
  );
}
