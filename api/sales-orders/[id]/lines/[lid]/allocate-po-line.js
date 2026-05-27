import { sql } from '../../../../../lib/db.js';
import { requireUser } from '../../../../../lib/session.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const lineId = parseInt(req.query.lid, 10);
  if (!Number.isFinite(lineId)) return res.status(400).json({ error: 'Invalid line id' });

  if (req.method === 'POST') {
    const poLineId = parseInt(req.body?.po_line_id, 10);
    const qty = parseInt(req.body?.qty, 10);
    if (!Number.isFinite(poLineId) || !Number.isFinite(qty) || qty < 1) {
      return res.status(400).json({ error: 'po_line_id and qty (>=1) are required' });
    }

    const lineRows = await sql`
      SELECT product_id, quantity_ordered FROM erp_sales_order_lines WHERE id = ${lineId} LIMIT 1
    `;
    if (lineRows.length === 0) return res.status(404).json({ error: 'SO line not found' });
    const soLine = lineRows[0];

    const polRows = await sql`
      SELECT pol.product_id, pol.quantity_ordered, pol.quantity_received,
             COALESCE((SELECT SUM(qty) FROM erp_so_po_allocations WHERE po_line_id = pol.id), 0) AS qty_allocated,
             po.status AS po_status
      FROM erp_purchase_order_lines pol
      JOIN erp_purchase_orders po ON po.id = pol.po_id
      WHERE pol.id = ${poLineId}
      LIMIT 1
    `;
    if (polRows.length === 0) return res.status(404).json({ error: 'PO line not found' });
    const polLine = polRows[0];

    if (soLine.product_id !== polLine.product_id) {
      return res.status(409).json({ error: 'PO line product does not match SO line product' });
    }
    if (['received', 'closed', 'cancelled'].includes(polLine.po_status)) {
      return res.status(409).json({ error: `Cannot allocate against a ${polLine.po_status} PO` });
    }

    const remainingPo = polLine.quantity_ordered - polLine.quantity_received - Number(polLine.qty_allocated);
    if (qty > remainingPo) {
      return res.status(409).json({ error: `PO line only has ${remainingPo} available to allocate` });
    }

    // Check SO line not over-allocated
    const soCounts = await sql`
      SELECT
        (SELECT COUNT(*) FROM erp_product_serials WHERE allocated_to_so_line_id = ${lineId}) AS serial_qty,
        (SELECT COALESCE(SUM(qty), 0) FROM erp_so_po_allocations WHERE so_line_id = ${lineId}) AS po_qty
    `;
    const allocated = Number(soCounts[0].serial_qty) + Number(soCounts[0].po_qty);
    if (allocated + qty > soLine.quantity_ordered) {
      return res.status(409).json({ error: `Allocation would exceed SO line qty (ordered ${soLine.quantity_ordered}, already allocated ${allocated})` });
    }

    const rows = await sql`
      INSERT INTO erp_so_po_allocations (so_line_id, po_line_id, qty, notes, created_by)
      VALUES (${lineId}, ${poLineId}, ${qty}, ${req.body?.notes || null}, ${user.id})
      RETURNING *
    `;
    return res.status(201).json({ ok: true, allocation: rows[0] });
  }

  res.setHeader('Allow', 'POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
