import { sql } from '../../../../lib/db.js';
import { requireUser } from '../../../../lib/session.js';
import { recomputeSoTotals } from '../../../../lib/sales-orders.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const soId = parseInt(req.query.id, 10);
  const lineId = parseInt(req.query.lid, 10);
  if (!Number.isFinite(soId) || !Number.isFinite(lineId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  const soRows = await sql`SELECT status FROM erp_sales_orders WHERE id = ${soId} LIMIT 1`;
  if (soRows.length === 0) return res.status(404).json({ error: 'Sales order not found' });
  if (['despatched', 'invoiced', 'complete', 'cancelled'].includes(soRows[0].status)) {
    return res.status(409).json({ error: `Cannot edit lines on a ${soRows[0].status} order` });
  }

  if (req.method === 'PUT') {
    const b = req.body || {};
    const existing = await sql`SELECT * FROM erp_sales_order_lines WHERE id = ${lineId} AND so_id = ${soId} LIMIT 1`;
    if (existing.length === 0) return res.status(404).json({ error: 'Line not found' });
    const e = existing[0];

    const qty = b.quantity_ordered != null ? Math.max(1, parseInt(b.quantity_ordered, 10) || 1) : e.quantity_ordered;
    const unitPrice = b.unit_price_pence != null ? parseInt(b.unit_price_pence, 10) : e.unit_price_pence;
    const discount = b.discount_percent != null
      ? Math.max(0, Math.min(100, Number(b.discount_percent) || 0))
      : Number(e.discount_percent);
    const description = b.description != null ? (b.description || '').trim() || e.description : e.description;
    const vatRate = b.vat_rate_percent != null ? parseInt(b.vat_rate_percent, 10) : e.vat_rate_percent;

    const rows = await sql`
      UPDATE erp_sales_order_lines SET
        description = ${description},
        quantity_ordered = ${qty},
        unit_price_pence = ${unitPrice},
        discount_percent = ${discount},
        vat_rate_percent = ${vatRate}
      WHERE id = ${lineId} AND so_id = ${soId}
      RETURNING *
    `;
    const totals = await recomputeSoTotals(soId);
    return res.status(200).json({ ok: true, line: rows[0], totals });
  }

  if (req.method === 'DELETE') {
    const rows = await sql`DELETE FROM erp_sales_order_lines WHERE id = ${lineId} AND so_id = ${soId} RETURNING id`;
    if (rows.length === 0) return res.status(404).json({ error: 'Line not found' });
    const totals = await recomputeSoTotals(soId);
    return res.status(200).json({ ok: true, totals });
  }

  res.setHeader('Allow', 'PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
