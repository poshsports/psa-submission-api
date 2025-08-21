// /api/db/groups.js
import pool from './pool.js';

export async function list_groups({ limit = 50, offset = 0 } = {}) {
  const sql = `
    select
      id,
      code,
      status,
      notes,
      created_at,
      updated_at,
      shipped_at,
      returned_at,
      submission_count
    from groups_overview
    order by created_at desc
    limit $1 offset $2
  `;
  const { rows } = await pool.query(sql, [limit, offset]);
  return rows;
}

export async function get_group(id) {
  const sql = `
    select
      id,
      code,
      status,
      notes,
      created_at,
      updated_at,
      shipped_at,
      returned_at,
      submission_count
    from groups_overview
    where id = $1
  `;
  const { rows } = await pool.query(sql, [id]);
  return rows[0] || null;
}
