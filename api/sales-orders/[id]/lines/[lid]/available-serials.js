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

  const lineRows = await sql`
    SELECT product_id FROM erp_sales_order_lines WHERE id = ${lineId} LIMIT 1
  `;
  if (lineRows.length === 0) return res.status(404).json({ error: 'SO line not found' });
  const productId = lineRows[0].product_id;
  if (!productId) return res.status(200).json({ ok: true, serials: [], note: 'Line has no linked product' });

  const serials = await sql`
    SELECT s.id, s.serial_number, s.status, s.warehouse_id, w.code AS warehouse_code
    FROM erp_product_serials s
    LEFT JOIN erp_warehouses w ON w.id = s.warehouse_id
    WHERE s.product_id = ${productId}
      AND s.status = 'in_stock'
      AND s.allocated_to_so_line_id IS NULL
    ORDER BY s.serial_number ASC
  `;
  return res.status(200).json({ ok: true, serials });
}
