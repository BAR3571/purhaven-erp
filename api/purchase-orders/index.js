import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';
import { nextPoNumber } from '../../lib/purchase-orders.js';
import { getMainWarehouseId } from '../../lib/stock.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const q = (req.query.q || '').trim();
    const status = (req.query.status || '').trim() || null;
    const likeQ = q ? '%' + q + '%' : null;

    const rows = await sql`
      SELECT po.*,
             s.name AS supplier_name,
             s.account_code AS supplier_code,
             (SELECT COUNT(*) FROM erp_purchase_order_lines WHERE po_id = po.id) AS line_count
      FROM erp_purchase_orders po
      JOIN erp_suppliers s ON s.id = po.supplier_id
      WHERE (${likeQ}::text IS NULL
             OR po.po_number ILIKE ${likeQ}
             OR s.name ILIKE ${likeQ}
             OR po.supplier_ref ILIKE ${likeQ})
        AND (${status}::text IS NULL OR po.status = ${status})
      ORDER BY po.order_date DESC, po.id DESC
    `;
    return res.status(200).json({ ok: true, purchase_orders: rows });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const supplierId = parseInt(b.supplier_id, 10);
    if (!Number.isFinite(supplierId)) return res.status(400).json({ error: 'supplier_id is required' });

    const supRows = await sql`SELECT * FROM erp_suppliers WHERE id = ${supplierId} LIMIT 1`;
    if (supRows.length === 0) return res.status(404).json({ error: 'Supplier not found' });
    const supplier = supRows[0];

    const poNumber = (b.po_number || '').trim() || (await nextPoNumber());
    const warehouseId = b.deliver_to_warehouse_id
      ? parseInt(b.deliver_to_warehouse_id, 10)
      : await getMainWarehouseId();

    try {
      const rows = await sql`
        INSERT INTO erp_purchase_orders (
          po_number, supplier_id, status, supplier_ref,
          order_date, expected_date, deliver_to_warehouse_id,
          currency, notes, created_by
        ) VALUES (
          ${poNumber}, ${supplierId}, 'draft', ${b.supplier_ref || null},
          COALESCE(${b.order_date || null}::date, CURRENT_DATE),
          ${b.expected_date || null},
          ${warehouseId},
          ${b.currency || supplier.currency || 'GBP'},
          ${b.notes || null},
          ${user.id}
        )
        RETURNING *
      `;
      return res.status(201).json({ ok: true, purchase_order: rows[0] });
    } catch (err) {
      if (err.message?.includes('erp_purchase_orders_po_number_key')) {
        return res.status(409).json({ error: `PO number ${poNumber} already exists` });
      }
      return res.status(500).json({ error: err.message });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
