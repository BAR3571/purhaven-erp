import { sql } from '../../../lib/db.js';
import { requireUser } from '../../../lib/session.js';
import { recomputePoTotals } from '../../../lib/purchase-orders.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const poId = parseInt(req.query.id, 10);
  if (!Number.isFinite(poId)) return res.status(400).json({ error: 'Invalid PO id' });

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const poRows = await sql`SELECT status FROM erp_purchase_orders WHERE id = ${poId} LIMIT 1`;
  if (poRows.length === 0) return res.status(404).json({ error: 'Purchase order not found' });
  if (['received', 'closed', 'cancelled'].includes(poRows[0].status)) {
    return res.status(409).json({ error: `Cannot add lines to a ${poRows[0].status} order` });
  }

  const b = req.body || {};
  const productId = b.product_id ? parseInt(b.product_id, 10) : null;
  let sku = (b.sku || '').trim();
  let description = (b.description || '').trim();
  let unitCost = b.unit_cost_pence ?? null;
  let vatRate = b.vat_rate_percent ?? 20;

  if (productId) {
    const prodRows = await sql`SELECT sku, name, cost_price_pence, vat_rate_percent FROM erp_products WHERE id = ${productId} LIMIT 1`;
    if (prodRows.length === 0) return res.status(404).json({ error: 'Product not found' });
    const p = prodRows[0];
    if (!sku) sku = p.sku;
    if (!description) description = p.name;
    if (unitCost == null) unitCost = p.cost_price_pence ?? 0;
    if (b.vat_rate_percent == null) vatRate = p.vat_rate_percent ?? 20;
  }

  if (!description) return res.status(400).json({ error: 'Description is required (or pick a product)' });

  const qty = Math.max(1, parseInt(b.quantity_ordered, 10) || 1);

  const maxRows = await sql`SELECT COALESCE(MAX(line_no), 0) AS m FROM erp_purchase_order_lines WHERE po_id = ${poId}`;
  const lineNo = (maxRows[0]?.m || 0) + 1;

  const rows = await sql`
    INSERT INTO erp_purchase_order_lines (
      po_id, line_no, product_id, sku, description,
      quantity_ordered, unit_cost_pence, vat_rate_percent
    ) VALUES (
      ${poId}, ${lineNo}, ${productId}, ${sku || null}, ${description},
      ${qty}, ${unitCost ?? 0}, ${vatRate}
    )
    RETURNING *
  `;

  const totals = await recomputePoTotals(poId);
  return res.status(201).json({ ok: true, line: rows[0], totals });
}
