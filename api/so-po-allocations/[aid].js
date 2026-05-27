import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';

// DELETE an SO↔PO allocation by its id
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const aid = parseInt(req.query.aid, 10);
  if (!Number.isFinite(aid)) return res.status(400).json({ error: 'Invalid allocation id' });

  if (req.method === 'DELETE') {
    const rows = await sql`DELETE FROM erp_so_po_allocations WHERE id = ${aid} RETURNING id`;
    if (rows.length === 0) return res.status(404).json({ error: 'Allocation not found' });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
