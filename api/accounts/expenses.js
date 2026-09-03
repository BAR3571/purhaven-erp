import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';

// GET  /api/accounts/expenses[?from=&to=&category_id=]
//         → list expenses, newest first, joined with category + bank
// POST /api/accounts/expenses
//         → create a new expense
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const from = req.query.from || null;
    const to   = req.query.to   || null;
    const catId = req.query.category_id ? parseInt(req.query.category_id, 10) : null;

    const rows = await sql`
      SELECT e.id, e.expense_date, e.category_id, ec.name AS category_name,
             e.supplier, e.description, e.amount_pence, e.vat_pence,
             e.bank_account_id, ba.name AS bank_account_name,
             e.receipt_url, e.notes, e.created_at
      FROM erp_expenses e
      LEFT JOIN erp_expense_categories ec ON ec.id = e.category_id
      LEFT JOIN erp_bank_accounts ba ON ba.id = e.bank_account_id
      WHERE (${from}::date IS NULL OR e.expense_date >= ${from})
        AND (${to}::date   IS NULL OR e.expense_date <= ${to})
        AND (${catId}::int IS NULL OR e.category_id = ${catId})
      ORDER BY e.expense_date DESC, e.id DESC
    `;

    // Also return categories so the frontend can render dropdowns without a second call
    const categories = await sql`
      SELECT id, name FROM erp_expense_categories WHERE active = TRUE ORDER BY sort_order ASC, name ASC
    `;
    const banks = await sql`
      SELECT id, name FROM erp_bank_accounts WHERE active = TRUE ORDER BY name ASC
    `;

    return res.status(200).json({ ok: true, expenses: rows, categories, bank_accounts: banks });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    if (!b.expense_date) return res.status(400).json({ error: 'expense_date required' });
    if (!b.description)  return res.status(400).json({ error: 'description required' });
    if (b.amount == null) return res.status(400).json({ error: 'amount required' });
    const amountPence = Math.round(Number(b.amount) * 100);
    const vatPence = b.vat != null ? Math.round(Number(b.vat) * 100) : null;

    const [row] = await sql`
      INSERT INTO erp_expenses (
        expense_date, category_id, supplier, description, amount_pence, vat_pence,
        bank_account_id, receipt_url, notes, created_by
      ) VALUES (
        ${b.expense_date}, ${b.category_id || null}, ${b.supplier || null},
        ${b.description}, ${amountPence}, ${vatPence},
        ${b.bank_account_id || null}, ${b.receipt_url || null},
        ${b.notes || null}, ${user.id}
      )
      RETURNING id
    `;

    // If a bank account was chosen, also mirror this into erp_bank_transactions
    // as an outflow so cash position reflects it. Sprint 2 will let the Revolut
    // auto-import match to the same expense instead of creating a duplicate.
    if (b.bank_account_id) {
      await sql`
        INSERT INTO erp_bank_transactions (
          bank_account_id, txn_date, amount_pence, description, matched_expense_id, imported_from
        ) VALUES (
          ${b.bank_account_id}, ${b.expense_date}, ${-amountPence},
          ${b.description}, ${row.id}, 'manual'
        )
      `;
    }

    return res.status(201).json({ ok: true, id: row.id });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
