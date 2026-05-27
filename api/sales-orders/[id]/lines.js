import { sql } from '../../../lib/db.js';
import { requireUser } from '../../../lib/session.js';
import { recomputeSoTotals } from '../../../lib/sales-orders.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const soId = parseInt(req.query.id, 10);
  if (!Number.isFinite(soId)) return res.status(400).json({ error: 'Invalid SO id' });

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Block edits on finalised orders
  const soRows = await sql`SELECT status FROM erp_sales_orders WHERE id = ${soId} LIMIT 1`;
  if (soRows.length === 0) return res.status(404).json({ error: 'Sales order not found' });
  if (['despatched', 'invoiced', 'complete', 'cancelled'].includes(soRows[0].status)) {
    return res.status(409).json({ error: `Cannot add lines to a ${soRows[0].status} order` });
  }

  const b = req.body || {};
  const productId = b.product_id ? parseInt(b.product_id, 10) : null;
  let sku = (b.sku || '').trim();
  let description = (b.description || '').trim();
  let unitPrice = b.unit_price_pence ?? null;
  let costPrice = b.cost_price_pence ?? null;
  let vatRate = b.vat_rate_percent ?? 20;

  // Snapshot from product if linked
  if (productId) {
    const prodRows = await sql`SELECT sku, name, sale_price_pence, cost_price_pence, vat_rate_percent FROM erp_products WHERE id = ${productId} LIMIT 1`;
    if (prodRows.length === 0) return res.status(404).json({ error: 'Product not found' });
    const p = prodRows[0];
    if (!sku) sku = p.sku;
    if (!description) description = p.name;
    if (unitPrice == null) unitPrice = p.sale_price_pence ?? 0;
    if (costPrice == null) costPrice = p.cost_price_pence ?? null;
    if (b.vat_rate_percent == null) vatRate = p.vat_rate_percent ?? 20;
  }

  if (!description) return res.status(400).json({ error: 'Description is required (or pick a product)' });

  const qty = Math.max(1, parseInt(b.quantity_ordered, 10) || 1);
  const discount = Math.max(0, Math.min(100, Number(b.discount_percent) || 0));

  // Next line_no
  const maxRows = await sql`SELECT COALESCE(MAX(line_no), 0) AS m FROM erp_sales_order_lines WHERE so_id = ${soId}`;
  const lineNo = (maxRows[0]?.m || 0) + 1;

  const rows = await sql`
    INSERT INTO erp_sales_order_lines (
      so_id, line_no, product_id, sku, description,
      quantity_ordered, unit_price_pence, discount_percent,
      cost_price_pence, vat_rate_percent
    ) VALUES (
      ${soId}, ${lineNo}, ${productId}, ${sku || null}, ${description},
      ${qty}, ${unitPrice ?? 0}, ${discount},
      ${costPrice}, ${vatRate}
    )
    RETURNING *
  `;

  const totals = await recomputeSoTotals(soId);
  return res.status(201).json({ ok: true, line: rows[0], totals });
}
