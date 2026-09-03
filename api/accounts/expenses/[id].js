import { sql } from '../../../lib/db.js';
import { requireUser } from '../../../lib/session.js';

// PUT / DELETE /api/accounts/expenses/[id]
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  if (req.method === 'DELETE') {
    // Undo any mirrored bank txn first so cash position stays consistent
    await sql`DELETE FROM erp_bank_transactions WHERE matched_expense_id = ${id}`;
    await sql`DELETE FROM erp_expenses WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'PUT') {
    const b = req.body || {};
    const amountPence = b.amount != null ? Math.round(Number(b.amount) * 100) : null;
    const vatPence    = b.vat    != null ? Math.round(Number(b.vat)    * 100) : null;
    await sql`
      UPDATE erp_expenses SET
        expense_date = COALESCE(${b.expense_date}, expense_date),
        category_id  = COALESCE(${b.category_id || null}, category_id),
        supplier     = COALESCE(${b.supplier || null}, supplier),
        description  = COALESCE(${b.description || null}, description),
        amount_pence = COALESCE(${amountPence}, amount_pence),
        vat_pence    = COALESCE(${vatPence}, vat_pence),
        bank_account_id = COALESCE(${b.bank_account_id || null}, bank_account_id),
        receipt_url  = COALESCE(${b.receipt_url || null}, receipt_url),
        notes        = COALESCE(${b.notes || null}, notes),
        updated_at   = NOW()
      WHERE id = ${id}
    `;
    // Sync the mirrored bank txn (if any) to reflect the new amount / date
    if (amountPence != null || b.expense_date) {
      await sql`
        UPDATE erp_bank_transactions SET
          amount_pence = ${amountPence != null ? -amountPence : null},
          txn_date = COALESCE(${b.expense_date}, txn_date)
        WHERE matched_expense_id = ${id}
      `;
    }
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
