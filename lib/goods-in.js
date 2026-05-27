import { sql } from './db.js';

export async function nextGiNumber() {
  const rows = await sql`SELECT MAX(id) AS max_id FROM erp_goods_in`;
  const next = (rows[0]?.max_id || 0) + 1;
  return `GI-${String(next).padStart(5, '0')}`;
}

export async function getGiWithRelations(id) {
  const rows = await sql`
    SELECT gi.*,
           po.po_number, po.id AS po_id,
           s.name AS supplier_name, s.account_code AS supplier_code,
           w.code AS warehouse_code, w.name AS warehouse_name,
           u.email AS received_by_email, u.name AS received_by_name
    FROM erp_goods_in gi
    LEFT JOIN erp_purchase_orders po ON po.id = gi.po_id
    LEFT JOIN erp_suppliers s ON s.id = po.supplier_id
    JOIN erp_warehouses w ON w.id = gi.warehouse_id
    LEFT JOIN erp_users u ON u.id = gi.received_by
    WHERE gi.id = ${id}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const gi = rows[0];

  const lines = await sql`
    SELECT gil.*,
           pol.line_no AS po_line_no
    FROM erp_goods_in_lines gil
    LEFT JOIN erp_purchase_order_lines pol ON pol.id = gil.po_line_id
    WHERE gil.gi_id = ${id}
    ORDER BY gil.id ASC
  `;

  const lineIds = lines.map(l => l.id);
  const serials = lineIds.length === 0 ? [] : await sql`
    SELECT id, serial_number, goods_in_line_id, status
    FROM erp_product_serials
    WHERE goods_in_line_id = ANY(${lineIds})
    ORDER BY serial_number ASC
  `;
  const serialsByLine = {};
  for (const s of serials) (serialsByLine[s.goods_in_line_id] ||= []).push(s);
  for (const l of lines) l.serials = serialsByLine[l.id] || [];

  return { ...gi, lines };
}

/**
 * After a goods-in is written, walk the PO's lines and update quantity_received
 * + roll the PO status forward (released → part_received → received).
 */
export async function refreshPoFromReceipts(poId) {
  // Recompute received per line
  await sql`
    UPDATE erp_purchase_order_lines pol
    SET quantity_received = COALESCE((
      SELECT SUM(qty_received) FROM erp_goods_in_lines WHERE po_line_id = pol.id
    ), 0)
    WHERE pol.po_id = ${poId}
  `;

  const lines = await sql`
    SELECT quantity_ordered, quantity_received FROM erp_purchase_order_lines WHERE po_id = ${poId}
  `;
  if (lines.length === 0) return;
  const allFull = lines.every(l => l.quantity_received >= l.quantity_ordered);
  const anyReceived = lines.some(l => l.quantity_received > 0);

  const current = await sql`SELECT status FROM erp_purchase_orders WHERE id = ${poId}`;
  if (current.length === 0) return;
  const curStatus = current[0].status;

  let newStatus = curStatus;
  if (allFull && ['released', 'part_received'].includes(curStatus)) newStatus = 'received';
  else if (anyReceived && curStatus === 'released') newStatus = 'part_received';

  if (newStatus !== curStatus) {
    await sql`UPDATE erp_purchase_orders SET status = ${newStatus}, updated_at = NOW() WHERE id = ${poId}`;
  }
}
