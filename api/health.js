import { sql } from '../lib/db.js';

export default async function handler(req, res) {
  try {
    const rows = await sql`SELECT NOW() as now, current_database() as db`;
    return res.status(200).json({
      ok: true,
      db: rows[0].db,
      now: rows[0].now,
      service: 'purhaven-erp'
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
