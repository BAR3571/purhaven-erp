import { sql } from '../../../../../lib/db.js';
import { requireUser } from '../../../../../lib/session.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const lineId = parseInt(req.query.lid, 10);
  if (!Number.isFinite(lineId)) return res.status(400).json({ error: 'Invalid line id' });

  const lineRows = await sql`SELECT product_id FROM erp_sales_order_lines WHERE id = ${lineId} LIMIT 1`;
  if (lineRows.length === 0) return res.status(404).json({ error: 'SO line not found' });
  const productId = lineRows[0].product_id;
  if (!productId) return res.status(200).json({ ok: true, po_lines: [], note: 'Line has no linked product' });

  // PO lines for the same product on draft/released/part_received POs with remaining capacity
  const rows = await sql`
    SELECT
      pol.id, pol.po_id, pol.line_no, pol.sku, pol.description,
      pol.quantity_ordered, pol.quantity_received,
      pol.unit_cost_pence,
      po.po_number, po.status AS po_status, po.expected_date,
      s.name AS supplier_name, s.account_code AS supplier_code,
      COALESCE((SELECT SUM(qty) FROM erp_so_po_allocations WHERE po_line_id = pol.id), 0) AS qty_allocated
    FROM erp_purchase_order_lines pol
    JOIN erp_purchase_orders po ON po.id = pol.po_id
    JOIN erp_suppliers s ON s.id = po.supplier_id
    WHERE pol.product_id = ${productId}
      AND po.status IN ('draft','released','part_received')
    ORDER BY po.expected_date NULLS LAST, po.id ASC
  `;
  const withCapacity = rows.map(r => ({
    ...r,
    qty_available_to_allocate: Math.max(0, r.quantity_ordered - r.quantity_received - Number(r.qty_allocated))
  })).filter(r => r.qty_available_to_allocate > 0);
  return res.status(200).json({ ok: true, po_lines: withCapacity });
}
