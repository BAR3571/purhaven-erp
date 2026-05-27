import { sql } from '../../../lib/db.js';
import { requireUser } from '../../../lib/session.js';
import { recomputePoTotals } from '../../../lib/purchase-orders.js';

// Status transitions on the PO header.
// part_received / received are set automatically by the Goods In module when stock arrives.
// 'close' marks a part-received PO as done (e.g. supplier under-shipped and the rest is cancelled).

const ALLOWED_FROM = {
  release: ['draft'],
  cancel:  ['draft', 'released', 'part_received'],
  close:   ['part_received', 'received']
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

  const rows = await sql`SELECT * FROM erp_purchase_orders WHERE id = ${id} LIMIT 1`;
  if (rows.length === 0) return res.status(404).json({ error: 'Purchase order not found' });
  const po = rows[0];

  if (!ALLOWED_FROM[action].includes(po.status)) {
    return res.status(409).json({ error: `Cannot ${action} a ${po.status} order` });
  }

  if (action === 'release') {
    const lines = await sql`SELECT id FROM erp_purchase_order_lines WHERE po_id = ${id}`;
    if (lines.length === 0) return res.status(400).json({ error: 'Add at least one line before releasing' });
    await recomputePoTotals(id);
    await sql`UPDATE erp_purchase_orders SET status = 'released', released_at = NOW(), updated_at = NOW() WHERE id = ${id}`;
  } else if (action === 'cancel') {
    await sql`UPDATE erp_purchase_orders SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = ${id}`;
  } else if (action === 'close') {
    await sql`UPDATE erp_purchase_orders SET status = 'closed', closed_at = NOW(), updated_at = NOW() WHERE id = ${id}`;
  }

  const updated = await sql`SELECT status FROM erp_purchase_orders WHERE id = ${id}`;
  return res.status(200).json({ ok: true, status: updated[0].status });
}
