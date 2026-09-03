import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';

// GET /api/accounts/bank-accounts  → list active bank accounts + current balance
// POST /api/accounts/bank-accounts → create a new bank account
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    // Compute current balance = opening + sum of transactions
    const rows = await sql`
      SELECT ba.id, ba.name, ba.provider, ba.currency, ba.opening_balance_pence,
             ba.opening_balance_date, ba.active, ba.notes,
             ba.opening_balance_pence + COALESCE(t.total, 0) AS current_balance_pence
      FROM erp_bank_accounts ba
      LEFT JOIN (
        SELECT bank_account_id, SUM(amount_pence) AS total
        FROM erp_bank_transactions
        GROUP BY bank_account_id
      ) t ON t.bank_account_id = ba.id
      WHERE ba.active = TRUE
      ORDER BY ba.name ASC
    `;
    return res.status(200).json({ ok: true, bank_accounts: rows });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name required' });
    const openingPence = Math.round((Number(b.opening_balance) || 0) * 100);
    const [row] = await sql`
      INSERT INTO erp_bank_accounts (name, provider, currency, opening_balance_pence, opening_balance_date, notes)
      VALUES (${b.name}, ${b.provider || null}, ${b.currency || 'GBP'}, ${openingPence},
              ${b.opening_balance_date || null}, ${b.notes || null})
      RETURNING id
    `;
    return res.status(201).json({ ok: true, id: row.id });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
