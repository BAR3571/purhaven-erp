import { sql } from '../../../lib/db.js';
import { requireUser } from '../../../lib/session.js';

// POST /api/sales-orders/:id/payment  { method, ref, amount_pence, paid_at?, notes?, processing_fee_pence?, bank_account_id? }
//   Records a payment against the SO. Used for off-website sales (email +
//   Revolut link, cash, bank transfer). Website orders paid via Merchant
//   webhook already have these fields populated automatically.
//
//   If processing_fee_pence > 0 we also insert a mirroring row into
//   erp_expenses under the 'Bank / payment fees' category so it flows through
//   the P&L as an overhead. The expense id is stamped onto the SO
//   (payment_expense_id) so we can clean it up on re-save or unmark.
//
// DELETE /api/sales-orders/:id/payment
//   Clears the payment stamp AND removes the linked fee expense.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const [so] = await sql`SELECT id, so_number, total_pence, currency, payment_expense_id FROM erp_sales_orders WHERE id = ${id} LIMIT 1`;
  if (!so) return res.status(404).json({ error: 'Sales order not found' });

  if (req.method === 'POST') {
    const b = req.body || {};
    const method = (b.method || '').trim();
    if (!method) return res.status(400).json({ error: 'Payment method is required' });
    const amountPence = b.amount_pence != null ? parseInt(b.amount_pence, 10) : so.total_pence;
    if (!Number.isFinite(amountPence) || amountPence <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number of pence' });
    }
    const feePence = b.processing_fee_pence != null && b.processing_fee_pence !== ''
      ? Math.abs(parseInt(b.processing_fee_pence, 10) || 0)
      : 0;
    const bankAccountId = b.bank_account_id ? parseInt(b.bank_account_id, 10) : null;
    const ref = (b.ref || '').trim() || null;
    const notes = (b.notes || '').trim() || null;
    const paidAt = b.paid_at ? new Date(b.paid_at) : new Date();
    if (isNaN(paidAt.getTime())) return res.status(400).json({ error: 'Invalid paid_at date' });

    // If we've been through this before, delete the old fee expense first so
    // updates don't double-book. FK on the SO is ON DELETE SET NULL so this
    // is safe.
    if (so.payment_expense_id) {
      await sql`DELETE FROM erp_expenses WHERE id = ${so.payment_expense_id}`;
    }

    // Create the fee expense if there is one
    let feeExpenseId = null;
    if (feePence > 0) {
      // Find the Bank / payment fees category id (falls back to Other)
      const [cat] = await sql`
        SELECT id FROM erp_expense_categories
        WHERE name IN ('Bank / payment fees', 'Bank charges', 'Other')
        ORDER BY CASE name
                   WHEN 'Bank / payment fees' THEN 1
                   WHEN 'Bank charges' THEN 2
                   ELSE 3
                 END
        LIMIT 1
      `;
      const [feeRow] = await sql`
        INSERT INTO erp_expenses (
          expense_date, category_id, supplier, description, amount_pence,
          bank_account_id, notes, created_by
        ) VALUES (
          ${paidAt.toISOString().slice(0,10)},
          ${cat?.id || null},
          ${method.includes('Revolut') ? 'Revolut' : method},
          ${`Card processing fee — ${so.so_number}`},
          ${feePence},
          ${bankAccountId},
          ${`Auto-created from SO ${so.so_number} payment. Method: ${method}${ref ? ' · ref ' + ref : ''}.`},
          ${user.id}
        )
        RETURNING id
      `;
      feeExpenseId = feeRow.id;
    }

    const [row] = await sql`
      UPDATE erp_sales_orders
      SET paid_at = ${paidAt.toISOString()},
          paid_amount_pence = ${amountPence},
          payment_method = ${method},
          payment_ref = ${ref},
          payment_notes = ${notes},
          processing_fee_pence = ${feePence || null},
          payment_bank_account_id = ${bankAccountId},
          payment_expense_id = ${feeExpenseId},
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING paid_at, paid_amount_pence, payment_method, payment_ref, payment_notes,
                processing_fee_pence, payment_bank_account_id, payment_expense_id
    `;

    return res.status(200).json({
      ok: true,
      payment: row,
      net_received_pence: amountPence - (feePence || 0),
      fee_expense_id: feeExpenseId
    });
  }

  if (req.method === 'DELETE') {
    // Clean up the linked fee expense first (if any)
    if (so.payment_expense_id) {
      await sql`DELETE FROM erp_expenses WHERE id = ${so.payment_expense_id}`;
    }
    await sql`
      UPDATE erp_sales_orders
      SET paid_at = NULL,
          paid_amount_pence = NULL,
          payment_method = NULL,
          payment_ref = NULL,
          payment_notes = NULL,
          processing_fee_pence = NULL,
          payment_bank_account_id = NULL,
          payment_expense_id = NULL,
          updated_at = NOW()
      WHERE id = ${id}
    `;
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
