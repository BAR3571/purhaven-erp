import { sql } from './db.js';

export async function nextPoNumber() {
  const rows = await sql`SELECT MAX(id) AS max_id FROM erp_purchase_orders`;
  const next = (rows[0]?.max_id || 0) + 1;
  return `PO-${String(next).padStart(5, '0')}`;
}

export async function recomputePoTotals(poId) {
  const lines = await sql`
    SELECT quantity_ordered, unit_cost_pence, vat_rate_percent
    FROM erp_purchase_order_lines WHERE po_id = ${poId}
  `;
  let subtotal = 0;
  let vat = 0;
  for (const l of lines) {
    const lineSub = Math.round(l.quantity_ordered * l.unit_cost_pence);
    const lineVat = Math.round(lineSub * (l.vat_rate_percent / 100));
    subtotal += lineSub;
    vat += lineVat;
  }
  const total = subtotal + vat;
  await sql`
    UPDATE erp_purchase_orders
    SET subtotal_pence = ${subtotal}, vat_pence = ${vat}, total_pence = ${total}, updated_at = NOW()
    WHERE id = ${poId}
  `;
  return { subtotal, vat, total };
}

export async function getPoWithRelations(id) {
  const rows = await sql`
    SELECT po.*,
           s.name AS supplier_name, s.account_code AS supplier_code,
           w.code AS warehouse_code, w.name AS warehouse_name
    FROM erp_purchase_orders po
    JOIN erp_suppliers s ON s.id = po.supplier_id
    LEFT JOIN erp_warehouses w ON w.id = po.deliver_to_warehouse_id
    WHERE po.id = ${id}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const po = rows[0];

  const lines = await sql`
    SELECT pol.*, p.image_url, p.requires_serial
    FROM erp_purchase_order_lines pol
    LEFT JOIN erp_products p ON p.id = pol.product_id
    WHERE pol.po_id = ${id}
    ORDER BY pol.line_no ASC
  `;

  const lineIds = lines.map(l => l.id);
  const allocs = lineIds.length === 0 ? [] : await sql`
    SELECT a.*,
           so.id AS so_id, so.so_number, so.status AS so_status,
           c.id AS customer_id, c.name AS customer_name, c.account_code AS customer_code,
           sol.line_no AS so_line_no, sol.sku AS so_sku, sol.description AS so_description
    FROM erp_so_po_allocations a
    JOIN erp_sales_order_lines sol ON sol.id = a.so_line_id
    JOIN erp_sales_orders so ON so.id = sol.so_id
    JOIN erp_customers c ON c.id = so.customer_id
    WHERE a.po_line_id = ANY(${lineIds})
    ORDER BY a.created_at ASC
  `;
  const byLine = {};
  for (const a of allocs) (byLine[a.po_line_id] ||= []).push(a);
  for (const l of lines) {
    l.allocated_so_lines = byLine[l.id] || [];
    l.qty_allocated_to_sos = l.allocated_so_lines.reduce((acc, x) => acc + x.qty, 0);
  }

  return { ...po, lines };
}
