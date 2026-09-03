import { sql } from '../../../lib/db.js';
import { requireUser } from '../../../lib/session.js';

// POST /api/sales-orders/:id/payment  { method, ref, amount_pence, paid_at?, notes? }
//   Records a payment against the SO. Used for off-website sales (email +
//   Revolut link, cash, bank transfer). Website orders paid via Merchant
//   webhook already have these fields populated automatically.
//
// DELETE /api/sales-orders/:id/payment
//   Clears the payment stamp (mark unpaid). Doesn't touch related bank
//   transactions — use with care.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const [so] = await sql`SELECT id, so_number, total_pence, currency FROM erp_sales_orders WHERE id = ${id} LIMIT 1`;
  if (!so) return res.status(404).json({ error: 'Sales order not found' });

  if (req.method === 'POST') {
    const b = req.body || {};
    const method = (b.method || '').trim();
    if (!method) return res.status(400).json({ error: 'Payment method is required' });
    const amountPence = b.amount_pence != null ? parseInt(b.amount_pence, 10) : so.total_pence;
    if (!Number.isFinite(amountPence) || amountPence <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number of pence' });
    }
    const ref = (b.ref || '').trim() || null;
    const notes = (b.notes || '').trim() || null;
    const paidAt = b.paid_at ? new Date(b.paid_at) : new Date();
    if (isNaN(paidAt.getTime())) return res.status(400).json({ error: 'Invalid paid_at date' });

    const [row] = await sql`
      UPDATE erp_sales_orders
      SET paid_at = ${paidAt.toISOString()},
          paid_amount_pence = ${amountPence},
          payment_method = ${method},
          payment_ref = ${ref},
          payment_notes = ${notes},
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING paid_at, paid_amount_pence, payment_method, payment_ref, payment_notes
    `;

    return res.status(200).json({ ok: true, payment: row });
  }

  if (req.method === 'DELETE') {
    await sql`
      UPDATE erp_sales_orders
      SET paid_at = NULL,
          paid_amount_pence = NULL,
          payment_method = NULL,
          payment_ref = NULL,
          payment_notes = NULL,
          updated_at = NOW()
      WHERE id = ${id}
    `;
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
