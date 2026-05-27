import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const rows = await sql`SELECT * FROM erp_warehouses WHERE active = TRUE ORDER BY code ASC`;
    return res.status(200).json({ ok: true, warehouses: rows });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const code = (b.code || '').trim().toUpperCase();
    const name = (b.name || '').trim();
    if (!code) return res.status(400).json({ error: 'Code is required' });
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const type = ['own', 'consignment', 'third_party'].includes(b.type) ? b.type : 'own';

    try {
      const rows = await sql`
        INSERT INTO erp_warehouses (code, name, type, notes)
        VALUES (${code}, ${name}, ${type}, ${b.notes || null})
        RETURNING *
      `;
      return res.status(201).json({ ok: true, warehouse: rows[0] });
    } catch (err) {
      if (err.message?.includes('erp_warehouses_code_key')) {
        return res.status(409).json({ error: `Warehouse ${code} already exists` });
      }
      return res.status(500).json({ error: err.message });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
