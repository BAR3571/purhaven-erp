import { sql } from './db.js';

export async function nextSoNumber() {
  const rows = await sql`SELECT MAX(id) AS max_id FROM erp_sales_orders`;
  const next = (rows[0]?.max_id || 0) + 1;
  return `SO-${String(next).padStart(5, '0')}`;
}

/**
 * Recompute subtotal / vat / total from lines and write back to the SO header.
 * Returns the updated totals.
 */
export async function recomputeSoTotals(soId) {
  const lines = await sql`
    SELECT quantity_ordered, unit_price_pence, discount_percent, vat_rate_percent
    FROM erp_sales_order_lines WHERE so_id = ${soId}
  `;
  let subtotal = 0;
  let vat = 0;
  for (const l of lines) {
    const lineSub = Math.round(l.quantity_ordered * l.unit_price_pence * (1 - Number(l.discount_percent) / 100));
    const lineVat = Math.round(lineSub * (l.vat_rate_percent / 100));
    subtotal += lineSub;
    vat += lineVat;
  }
  const total = subtotal + vat;
  await sql`
    UPDATE erp_sales_orders
    SET subtotal_pence = ${subtotal}, vat_pence = ${vat}, total_pence = ${total}, updated_at = NOW()
    WHERE id = ${soId}
  `;
  return { subtotal, vat, total };
}

export async function getSoWithRelations(id) {
  const rows = await sql`
    SELECT so.*,
           c.name AS customer_name, c.account_code AS customer_code
    FROM erp_sales_orders so
    JOIN erp_customers c ON c.id = so.customer_id
    WHERE so.id = ${id}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const so = rows[0];

  const lines = await sql`
    SELECT sol.*, p.image_url, p.requires_serial
    FROM erp_sales_order_lines sol
    LEFT JOIN erp_products p ON p.id = sol.product_id
    WHERE sol.so_id = ${id}
    ORDER BY sol.line_no ASC
  `;

  const lineIds = lines.map(l => l.id);
  const serialAllocs = lineIds.length === 0 ? [] : await sql`
    SELECT s.id, s.serial_number, s.status, s.allocated_to_so_line_id AS so_line_id, s.product_id
    FROM erp_product_serials s
    WHERE s.allocated_to_so_line_id = ANY(${lineIds})
  `;
  const poAllocs = lineIds.length === 0 ? [] : await sql`
    SELECT a.*, pol.line_no AS po_line_no, pol.sku AS po_sku, pol.description AS po_description,
           pol.quantity_ordered AS po_qty_ordered, pol.quantity_received AS po_qty_received,
           po.id AS po_id, po.po_number, po.status AS po_status,
           s.name AS supplier_name
    FROM erp_so_po_allocations a
    JOIN erp_purchase_order_lines pol ON pol.id = a.po_line_id
    JOIN erp_purchase_orders po ON po.id = pol.po_id
    JOIN erp_suppliers s ON s.id = po.supplier_id
    WHERE a.so_line_id = ANY(${lineIds})
    ORDER BY a.created_at ASC
  `;

  // Group allocations onto each line
  const serialsByLine = {};
  for (const sa of serialAllocs) (serialsByLine[sa.so_line_id] ||= []).push(sa);
  const posByLine = {};
  for (const pa of poAllocs) (posByLine[pa.so_line_id] ||= []).push(pa);

  for (const l of lines) {
    l.allocated_serials = serialsByLine[l.id] || [];
    l.allocated_po_lines = posByLine[l.id] || [];
    const serialQty = l.allocated_serials.length;
    const poQty = l.allocated_po_lines.reduce((a, b) => a + b.qty, 0);
    l.qty_allocated_total = serialQty + poQty;
  }

  return { ...so, lines };
}
