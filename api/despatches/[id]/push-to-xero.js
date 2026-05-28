import { requireUser } from '../../../lib/session.js';
import { sql } from '../../../lib/db.js';
import { pushDespatchInvoice, isConfigured, getStoredTokens } from '../../../lib/xero.js';

// POST /api/despatches/:id/push-to-xero
// Builds a sales invoice from the despatch + its SO and pushes it to Xero.
// Idempotent-ish: if the despatch already has an xero_invoice_id we return
// it without re-posting.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  if (!isConfigured()) {
    return res.status(400).json({ error: 'Xero is not configured — set XERO_CLIENT_ID/SECRET/REDIRECT_URI.' });
  }
  if (!(await getStoredTokens())) {
    return res.status(400).json({ error: 'Xero is not yet connected — visit /api/admin/xero-connect.' });
  }

  try {
    const [despatch] = await sql`SELECT * FROM erp_despatches WHERE id = ${id} LIMIT 1`;
    if (!despatch) return res.status(404).json({ error: 'Despatch not found' });

    if (despatch.xero_invoice_id) {
      return res.status(200).json({
        ok: true,
        already_pushed: true,
        xero_invoice_id: despatch.xero_invoice_id,
        message: 'This despatch already has a Xero invoice. Refusing to duplicate.'
      });
    }

    const [so] = await sql`SELECT * FROM erp_sales_orders WHERE id = ${despatch.so_id} LIMIT 1`;
    if (!so) return res.status(400).json({ error: 'Parent SO not found' });
    const [customer] = await sql`SELECT * FROM erp_customers WHERE id = ${so.customer_id} LIMIT 1`;
    if (!customer) return res.status(400).json({ error: 'Customer not found' });

    const lines = await sql`
      SELECT dnl.sku, dnl.description, dnl.qty_to_despatch, dnl.qty_picked, dnl.qty_despatched,
             sol.unit_price_pence, sol.discount_percent, sol.quantity_ordered
      FROM erp_despatch_lines dnl
      LEFT JOIN erp_sales_order_lines sol ON sol.id = dnl.so_line_id
      WHERE dnl.despatch_id = ${id}
      ORDER BY dnl.id ASC
    `;
    if (lines.length === 0) return res.status(400).json({ error: 'Despatch has no lines' });

    const result = await pushDespatchInvoice({ despatch, so, customer, lines });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
