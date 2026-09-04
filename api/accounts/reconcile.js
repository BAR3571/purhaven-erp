import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';

// POST /api/accounts/reconcile
//   Body variants:
//     { action: 'mark',    txn_ids: [...], reconciled: true|false, statement_ref? }
//        Toggles reconciled state on a set of transactions.
//     { action: 'complete', bank_account_id, through_date, statement_closing_balance_pence }
//        Verifies the ERP's computed running balance at through_date matches
//        the statement closing balance. Stamps reconciled_through on the
//        account so future entries can't backdate into a closed period.
//     { action: 'reopen', bank_account_id, through_date }
//        Rolls reconciled_through back to before through_date. Doesn't clear
//        per-txn reconciled flags (those stay for audit).
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const b = req.body || {};
  const action = (b.action || '').trim();

  if (action === 'mark') {
    const ids = Array.isArray(b.txn_ids) ? b.txn_ids.map(x => parseInt(x, 10)).filter(Number.isFinite) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'txn_ids required (non-empty array)' });
    const reconciled = b.reconciled !== false;
    const ref = (b.statement_ref || '').trim() || null;

    if (reconciled) {
      await sql`
        UPDATE erp_bank_transactions
        SET reconciled_at = NOW(),
            reconciled_by = ${user.id},
            reconciled_ref = ${ref}
        WHERE id = ANY(${ids})
      `;
    } else {
      await sql`
        UPDATE erp_bank_transactions
        SET reconciled_at = NULL,
            reconciled_by = NULL,
            reconciled_ref = NULL
        WHERE id = ANY(${ids})
      `;
    }
    return res.status(200).json({ ok: true, updated: ids.length, reconciled });
  }

  if (action === 'complete') {
    const bankId = parseInt(b.bank_account_id, 10);
    if (!Number.isFinite(bankId)) return res.status(400).json({ error: 'bank_account_id required' });
    const through = b.through_date;
    if (!through) return res.status(400).json({ error: 'through_date required' });
    const stmtClosing = parseInt(b.statement_closing_balance_pence, 10);
    if (!Number.isFinite(stmtClosing)) return res.status(400).json({ error: 'statement_closing_balance_pence required' });

    const [acct] = await sql`SELECT id, opening_balance_pence, name FROM erp_bank_accounts WHERE id = ${bankId}`;
    if (!acct) return res.status(404).json({ error: 'Bank account not found' });

    const [{ sum_amt }] = await sql`
      SELECT COALESCE(SUM(amount_pence), 0)::int AS sum_amt
      FROM erp_bank_transactions
      WHERE bank_account_id = ${bankId} AND txn_date <= ${through}::date
    `;
    const computed = (acct.opening_balance_pence || 0) + sum_amt;
    const diff = computed - stmtClosing;

    if (diff !== 0) {
      return res.status(409).json({
        error: `Balance mismatch: ERP computes ${(computed/100).toFixed(2)} but statement shows ${(stmtClosing/100).toFixed(2)}. Difference: ${(diff/100).toFixed(2)}. Add or tick missing transactions before closing.`,
        computed_balance_pence: computed,
        statement_balance_pence: stmtClosing,
        difference_pence: diff
      });
    }

    // Also require ALL txns up to that date to be individually ticked
    const [{ unreconciled }] = await sql`
      SELECT COUNT(*)::int AS unreconciled
      FROM erp_bank_transactions
      WHERE bank_account_id = ${bankId} AND txn_date <= ${through}::date AND reconciled_at IS NULL
    `;
    if (unreconciled > 0) {
      return res.status(409).json({
        error: `${unreconciled} transaction${unreconciled === 1 ? '' : 's'} in the period still not ticked as reconciled. Tick every row before closing.`,
        unreconciled_count: unreconciled
      });
    }

    await sql`
      UPDATE erp_bank_accounts
      SET reconciled_through = ${through}::date,
          last_reconciled_balance_pence = ${stmtClosing}
      WHERE id = ${bankId}
    `;
    return res.status(200).json({
      ok: true,
      bank_account: acct.name,
      reconciled_through: through,
      balance_pence: stmtClosing
    });
  }

  if (action === 'reopen') {
    const bankId = parseInt(b.bank_account_id, 10);
    if (!Number.isFinite(bankId)) return res.status(400).json({ error: 'bank_account_id required' });
    await sql`
      UPDATE erp_bank_accounts
      SET reconciled_through = NULL, last_reconciled_balance_pence = NULL
      WHERE id = ${bankId}
    `;
    return res.status(200).json({ ok: true, reopened: true });
  }

  return res.status(400).json({ error: `Unknown action: ${action}. Expected 'mark', 'complete', or 'reopen'.` });
}
