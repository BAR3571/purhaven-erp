import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';

// GET  /api/accounts/bank-transactions?bank_account_id=X&from=YYYY-MM-DD&to=YYYY-MM-DD
//    List txns for an account + period (or all-time if no dates).
// POST /api/accounts/bank-transactions
//    Body: { bank_account_id, txn_date, amount_pence (signed), description, reference?, notes? }
//    Manual add — used by the reconciliation UI to record txns that live on
//    the real statement but not yet in the ERP (e.g. a fee we forgot).
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const bankId = parseInt(req.query.bank_account_id, 10);
    if (!Number.isFinite(bankId)) return res.status(400).json({ error: 'bank_account_id required' });
    const fromDate = req.query.from || '1900-01-01';
    const toDate = req.query.to || '2999-12-31';

    const [acct] = await sql`
      SELECT id, name, currency, opening_balance_pence, opening_balance_date,
             reconciled_through, last_reconciled_balance_pence
      FROM erp_bank_accounts WHERE id = ${bankId}
    `;
    if (!acct) return res.status(404).json({ error: 'Bank account not found' });

    const txns = await sql`
      SELECT t.id, t.txn_date, t.amount_pence, t.description, t.reference,
             t.matched_so_id, t.matched_expense_id, t.matched_po_id,
             t.imported_from, t.reconciled_at, t.reconciled_by, t.reconciled_ref,
             so.so_number AS matched_so_number,
             po.po_number AS matched_po_number,
             ec.name      AS matched_expense_category,
             e.description AS matched_expense_description
      FROM erp_bank_transactions t
      LEFT JOIN erp_sales_orders so    ON so.id = t.matched_so_id
      LEFT JOIN erp_purchase_orders po ON po.id = t.matched_po_id
      LEFT JOIN erp_expenses e         ON e.id = t.matched_expense_id
      LEFT JOIN erp_expense_categories ec ON ec.id = e.category_id
      WHERE t.bank_account_id = ${bankId}
        AND t.txn_date >= ${fromDate}::date
        AND t.txn_date <= ${toDate}::date
      ORDER BY t.txn_date ASC, t.id ASC
    `;

    // Opening balance at the start of the period = opening_balance +
    // sum of all txns before `from`
    const [{ prior }] = await sql`
      SELECT COALESCE(SUM(amount_pence), 0)::int AS prior
      FROM erp_bank_transactions
      WHERE bank_account_id = ${bankId} AND txn_date < ${fromDate}::date
    `;
    const openingPence = (acct.opening_balance_pence || 0) + prior;

    // Running balance
    let running = openingPence;
    for (const t of txns) {
      running += t.amount_pence;
      t.running_balance_pence = running;
    }
    const closingPence = running;

    return res.status(200).json({
      ok: true,
      bank_account: acct,
      opening_balance_pence: openingPence,
      closing_balance_pence: closingPence,
      inflow_pence:  txns.reduce((s,t) => s + (t.amount_pence > 0 ? t.amount_pence : 0), 0),
      outflow_pence: txns.reduce((s,t) => s + (t.amount_pence < 0 ? t.amount_pence : 0), 0),
      reconciled_count:   txns.filter(t => t.reconciled_at).length,
      unreconciled_count: txns.filter(t => !t.reconciled_at).length,
      transactions: txns
    });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const bankId = parseInt(b.bank_account_id, 10);
    if (!Number.isFinite(bankId)) return res.status(400).json({ error: 'bank_account_id required' });
    const amount = parseInt(b.amount_pence, 10);
    if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'amount_pence must be non-zero integer' });
    const date = b.txn_date;
    if (!date) return res.status(400).json({ error: 'txn_date required' });

    // Soft check: don't accept a txn dated inside a closed period
    const [acct] = await sql`SELECT reconciled_through FROM erp_bank_accounts WHERE id = ${bankId}`;
    if (acct?.reconciled_through && new Date(date) <= new Date(acct.reconciled_through)) {
      return res.status(409).json({
        error: `Cannot add a transaction dated ${date} — account is reconciled through ${acct.reconciled_through.toISOString().slice(0,10)}. Reopen the period first if this is an adjustment.`
      });
    }

    const srcId = b.source_txn_id || `manual-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

    const [row] = await sql`
      INSERT INTO erp_bank_transactions (
        bank_account_id, txn_date, amount_pence, description, reference,
        imported_from, source_txn_id
      ) VALUES (
        ${bankId}, ${date}, ${amount}, ${b.description || null}, ${b.reference || null},
        'manual', ${srcId}
      )
      RETURNING id, txn_date, amount_pence, description
    `;
    return res.status(201).json({ ok: true, transaction: row });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
