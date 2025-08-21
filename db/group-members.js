// /api/db/group-members.js
import pool from './pool.js';

export async function list_group_members(groupId) {
  const sql = `
    select
      submission_id,
      position,
      created_at
    from group_submissions
    where group_id = $1
    order by position asc
  `;
  const { rows } = await pool.query(sql, [groupId]);
  return rows;
}
