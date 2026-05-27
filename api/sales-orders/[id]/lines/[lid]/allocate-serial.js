import { sql } from '../../../../../lib/db.js';
import { requireUser } from '../../../../../lib/session.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const lineId = parseInt(req.query.lid, 10);
  if (!Number.isFinite(lineId)) return res.status(400).json({ error: 'Invalid line id' });

  if (req.method === 'POST') {
    const serialId = parseInt(req.body?.serial_id, 10);
    if (!Number.isFinite(serialId)) return res.status(400).json({ error: 'serial_id is required' });

    const lineRows = await sql`
      SELECT product_id, quantity_ordered FROM erp_sales_order_lines WHERE id = ${lineId} LIMIT 1
    `;
    if (lineRows.length === 0) return res.status(404).json({ error: 'SO line not found' });
    const line = lineRows[0];

    const serialRows = await sql`
      SELECT id, product_id, status, allocated_to_so_line_id
      FROM erp_product_serials WHERE id = ${serialId} LIMIT 1
    `;
    if (serialRows.length === 0) return res.status(404).json({ error: 'Serial not found' });
    const serial = serialRows[0];

    if (serial.product_id !== line.product_id) {
      return res.status(409).json({ error: 'Serial product does not match SO line product' });
    }
    if (serial.allocated_to_so_line_id) {
      return res.status(409).json({ error: 'Serial is already allocated to another order line' });
    }
    if (serial.status !== 'in_stock') {
      return res.status(409).json({ error: `Cannot allocate a serial with status ${serial.status}` });
    }

    // Check we're not over-allocating the SO line
    const counts = await sql`
      SELECT
        (SELECT COUNT(*) FROM erp_product_serials WHERE allocated_to_so_line_id = ${lineId}) AS serial_qty,
        (SELECT COALESCE(SUM(qty), 0) FROM erp_so_po_allocations WHERE so_line_id = ${lineId}) AS po_qty
    `;
    const allocated = Number(counts[0].serial_qty) + Number(counts[0].po_qty);
    if (allocated + 1 > line.quantity_ordered) {
      return res.status(409).json({ error: `Allocation would exceed line qty (ordered ${line.quantity_ordered}, already allocated ${allocated})` });
    }

    await sql`
      UPDATE erp_product_serials SET allocated_to_so_line_id = ${lineId}
      WHERE id = ${serialId}
    `;
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const serialId = parseInt(req.query.serial_id, 10);
    if (!Number.isFinite(serialId)) return res.status(400).json({ error: 'serial_id is required' });
    const rows = await sql`
      UPDATE erp_product_serials SET allocated_to_so_line_id = NULL
      WHERE id = ${serialId} AND allocated_to_so_line_id = ${lineId}
      RETURNING id
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Allocation not found' });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
