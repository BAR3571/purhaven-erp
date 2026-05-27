import { sql } from '../../../../lib/db.js';
import { requireUser } from '../../../../lib/session.js';
import { recomputePoTotals } from '../../../../lib/purchase-orders.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const poId = parseInt(req.query.id, 10);
  const lineId = parseInt(req.query.lid, 10);
  if (!Number.isFinite(poId) || !Number.isFinite(lineId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  const poRows = await sql`SELECT status FROM erp_purchase_orders WHERE id = ${poId} LIMIT 1`;
  if (poRows.length === 0) return res.status(404).json({ error: 'Purchase order not found' });
  if (['received', 'closed', 'cancelled'].includes(poRows[0].status)) {
    return res.status(409).json({ error: `Cannot edit lines on a ${poRows[0].status} order` });
  }

  if (req.method === 'PUT') {
    const b = req.body || {};
    const existing = await sql`SELECT * FROM erp_purchase_order_lines WHERE id = ${lineId} AND po_id = ${poId} LIMIT 1`;
    if (existing.length === 0) return res.status(404).json({ error: 'Line not found' });
    const e = existing[0];

    const qty = b.quantity_ordered != null ? Math.max(1, parseInt(b.quantity_ordered, 10) || 1) : e.quantity_ordered;
    const unitCost = b.unit_cost_pence != null ? parseInt(b.unit_cost_pence, 10) : e.unit_cost_pence;
    const description = b.description != null ? (b.description || '').trim() || e.description : e.description;
    const vatRate = b.vat_rate_percent != null ? parseInt(b.vat_rate_percent, 10) : e.vat_rate_percent;

    const rows = await sql`
      UPDATE erp_purchase_order_lines SET
        description = ${description},
        quantity_ordered = ${qty},
        unit_cost_pence = ${unitCost},
        vat_rate_percent = ${vatRate}
      WHERE id = ${lineId} AND po_id = ${poId}
      RETURNING *
    `;
    const totals = await recomputePoTotals(poId);
    return res.status(200).json({ ok: true, line: rows[0], totals });
  }

  if (req.method === 'DELETE') {
    const rows = await sql`DELETE FROM erp_purchase_order_lines WHERE id = ${lineId} AND po_id = ${poId} RETURNING id`;
    if (rows.length === 0) return res.status(404).json({ error: 'Line not found' });
    const totals = await recomputePoTotals(poId);
    return res.status(200).json({ ok: true, totals });
  }

  res.setHeader('Allow', 'PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
