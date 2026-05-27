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
  return { ...so, lines };
}
