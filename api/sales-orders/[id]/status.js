import { sql } from '../../../lib/db.js';
import { requireUser } from '../../../lib/session.js';
import { recomputeSoTotals } from '../../../lib/sales-orders.js';

// Status transitions managed manually on the SO header.
// Picking / Part Despatched / Despatched / Invoiced / Complete are set by the Despatch + Invoice modules.

const ALLOWED_FROM = {
  confirm:    ['draft', 'on_hold'],
  hold:       ['draft', 'confirmed'],
  unhold:     ['on_hold'],
  cancel:     ['draft', 'confirmed', 'on_hold']
};

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const action = (req.body?.action || '').trim();
  if (!ALLOWED_FROM[action]) return res.status(400).json({ error: 'Unknown action' });

  const rows = await sql`SELECT * FROM erp_sales_orders WHERE id = ${id} LIMIT 1`;
  if (rows.length === 0) return res.status(404).json({ error: 'Sales order not found' });
  const so = rows[0];

  if (!ALLOWED_FROM[action].includes(so.status)) {
    return res.status(409).json({ error: `Cannot ${action} a ${so.status} order` });
  }

  if (action === 'confirm') {
    const lines = await sql`SELECT id FROM erp_sales_order_lines WHERE so_id = ${id}`;
    if (lines.length === 0) return res.status(400).json({ error: 'Add at least one line before confirming' });
    await recomputeSoTotals(id);
    await sql`
      UPDATE erp_sales_orders
      SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
    `;
  } else if (action === 'hold') {
    await sql`UPDATE erp_sales_orders SET status = 'on_hold', updated_at = NOW() WHERE id = ${id}`;
  } else if (action === 'unhold') {
    // Return to draft if never confirmed, else confirmed
    const newStatus = so.confirmed_at ? 'confirmed' : 'draft';
    await sql`UPDATE erp_sales_orders SET status = ${newStatus}, updated_at = NOW() WHERE id = ${id}`;
  } else if (action === 'cancel') {
    await sql`
      UPDATE erp_sales_orders
      SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
    `;
  }

  const updated = await sql`SELECT status FROM erp_sales_orders WHERE id = ${id}`;
  return res.status(200).json({ ok: true, status: updated[0].status });
}
