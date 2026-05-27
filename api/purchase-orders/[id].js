import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';
import { getPoWithRelations } from '../../lib/purchase-orders.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  if (req.method === 'GET') {
    const po = await getPoWithRelations(id);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    return res.status(200).json({ ok: true, purchase_order: po });
  }

  if (req.method === 'PUT') {
    const b = req.body || {};
    const existing = await sql`SELECT * FROM erp_purchase_orders WHERE id = ${id} LIMIT 1`;
    if (existing.length === 0) return res.status(404).json({ error: 'Purchase order not found' });
    const e = existing[0];

    if (['received', 'closed', 'cancelled'].includes(e.status)) {
      return res.status(409).json({ error: `Cannot edit a ${e.status} order` });
    }

    const rows = await sql`
      UPDATE erp_purchase_orders SET
        supplier_ref = ${b.supplier_ref === undefined ? e.supplier_ref : (b.supplier_ref || null)},
        order_date = ${b.order_date || e.order_date},
        expected_date = ${b.expected_date === undefined ? e.expected_date : (b.expected_date || null)},
        deliver_to_warehouse_id = ${b.deliver_to_warehouse_id === undefined ? e.deliver_to_warehouse_id : (b.deliver_to_warehouse_id || null)},
        currency = ${b.currency || e.currency},
        notes = ${b.notes === undefined ? e.notes : (b.notes || null)},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return res.status(200).json({ ok: true, purchase_order: rows[0] });
  }

  if (req.method === 'DELETE') {
    const existing = await sql`SELECT status FROM erp_purchase_orders WHERE id = ${id} LIMIT 1`;
    if (existing.length === 0) return res.status(404).json({ error: 'Purchase order not found' });
    if (existing[0].status !== 'draft') {
      return res.status(409).json({ error: `Only draft orders can be deleted (current status: ${existing[0].status})` });
    }
    await sql`DELETE FROM erp_purchase_orders WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
