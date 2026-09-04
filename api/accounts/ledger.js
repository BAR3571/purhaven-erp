import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';

// GET /api/accounts/ledger              — chart of accounts + balances at `to` date
// GET /api/accounts/ledger?code=XXXX&from=YYYY-MM-DD&to=YYYY-MM-DD
//     Detail view: all postings that hit this nominal code in the period,
//     with running balance. Sources aggregated:
//       - Sales / Refunds       from erp_sales_orders (revenue)
//       - Bank movements        from erp_bank_transactions (linked to bank accounts by nominal_account_id)
//       - Expense charges       from erp_expenses (via category → nominal)
//       - Manual journals       from erp_journal_lines
//
// This is a virtual ledger — postings aren't stored as double-entry legs.
// The natural "other side" of each posting is implicit (e.g. a bank inflow
// with matched_so_id has bank+ and sales-). Good enough for a small Ltd
// that hands off to a chartered accountant at year-end.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const code = (req.query.code || '').trim();
  const fromDate = req.query.from || '1900-01-01';
  const toDate   = req.query.to   || '2999-12-31';

  // === Chart-of-accounts overview ===
  if (!code) {
    const accts = await sql`
      SELECT id, code, name, type, active FROM erp_nominal_accounts
      WHERE active = TRUE ORDER BY code ASC
    `;

    // Balance = sum of all postings that hit this account on or before toDate.
    // Sign convention (what the bookkeeper sees):
    //   asset / expense / cogs / overhead: positive = has value / has been spent
    //   liability / income / equity:       positive = money owed / earned
    const balances = {};
    for (const a of accts) balances[a.code] = 0;

    // Bank transactions → posted to the bank account's nominal code
    const bankPost = await sql`
      SELECT na.code, COALESCE(SUM(t.amount_pence), 0)::int AS bal
      FROM erp_bank_transactions t
      JOIN erp_bank_accounts ba ON ba.id = t.bank_account_id
      JOIN erp_nominal_accounts na ON na.id = ba.nominal_account_id
      WHERE t.txn_date <= ${toDate}::date
      GROUP BY na.code
    `;
    // Opening balances on bank accounts
    const bankOpening = await sql`
      SELECT na.code, COALESCE(SUM(ba.opening_balance_pence), 0)::int AS bal
      FROM erp_bank_accounts ba
      JOIN erp_nominal_accounts na ON na.id = ba.nominal_account_id
      GROUP BY na.code
    `;
    for (const r of bankPost)    balances[r.code] = (balances[r.code] || 0) + r.bal;
    for (const r of bankOpening) balances[r.code] = (balances[r.code] || 0) + r.bal;

    // Expenses → posted to the category's nominal code
    const expPost = await sql`
      SELECT na.code, COALESCE(SUM(e.amount_pence), 0)::int AS bal
      FROM erp_expenses e
      JOIN erp_expense_categories ec ON ec.id = e.category_id
      JOIN erp_nominal_accounts na   ON na.id = ec.nominal_account_id
      WHERE e.expense_date <= ${toDate}::date
      GROUP BY na.code
    `;
    for (const r of expPost) balances[r.code] = (balances[r.code] || 0) + r.bal;

    // Sales → posted to 4000 Sales (ex-VAT) and 2200 VAT control
    const [{ sales_ex_vat }] = await sql`
      SELECT COALESCE(SUM(subtotal_pence), 0)::int AS sales_ex_vat
      FROM erp_sales_orders
      WHERE status != 'cancelled' AND order_date <= ${toDate}::date
    `;
    const [{ vat }] = await sql`
      SELECT COALESCE(SUM(vat_pence), 0)::int AS vat
      FROM erp_sales_orders
      WHERE status != 'cancelled' AND order_date <= ${toDate}::date
    `;
    balances['4000'] = (balances['4000'] || 0) + sales_ex_vat;
    balances['2200'] = (balances['2200'] || 0) + vat;

    // Journal lines → net (debit - credit)
    const jl = await sql`
      SELECT na.code, COALESCE(SUM(jl.debit_pence - jl.credit_pence), 0)::int AS bal
      FROM erp_journal_lines jl
      JOIN erp_journal_entries je ON je.id = jl.entry_id
      JOIN erp_nominal_accounts na ON na.id = jl.nominal_account_id
      WHERE je.entry_date <= ${toDate}::date
      GROUP BY na.code
    `;
    for (const r of jl) balances[r.code] = (balances[r.code] || 0) + r.bal;

    // Attach balance to each account row
    const rows = accts.map(a => ({ ...a, balance_pence: balances[a.code] || 0 }));

    // Trial-balance totals per type
    const totals = {};
    for (const a of rows) {
      totals[a.type] = (totals[a.type] || 0) + a.balance_pence;
    }

    return res.status(200).json({ ok: true, as_of: toDate, accounts: rows, totals });
  }

  // === Per-account detail ledger ===
  const [acct] = await sql`SELECT id, code, name, type FROM erp_nominal_accounts WHERE code = ${code}`;
  if (!acct) return res.status(404).json({ error: `Nominal account ${code} not found` });

  // Opening balance = everything before `from`
  let openingPence = 0;
  const priorBank = await sql`
    SELECT COALESCE(SUM(t.amount_pence), 0)::int AS bal
    FROM erp_bank_transactions t
    JOIN erp_bank_accounts ba ON ba.id = t.bank_account_id
    WHERE ba.nominal_account_id = ${acct.id} AND t.txn_date < ${fromDate}::date
  `;
  const priorBankOpen = await sql`
    SELECT COALESCE(SUM(opening_balance_pence), 0)::int AS bal
    FROM erp_bank_accounts WHERE nominal_account_id = ${acct.id}
  `;
  const priorExp = await sql`
    SELECT COALESCE(SUM(e.amount_pence), 0)::int AS bal
    FROM erp_expenses e
    JOIN erp_expense_categories ec ON ec.id = e.category_id
    WHERE ec.nominal_account_id = ${acct.id} AND e.expense_date < ${fromDate}::date
  `;
  const priorJl = await sql`
    SELECT COALESCE(SUM(jl.debit_pence - jl.credit_pence), 0)::int AS bal
    FROM erp_journal_lines jl
    JOIN erp_journal_entries je ON je.id = jl.entry_id
    WHERE jl.nominal_account_id = ${acct.id} AND je.entry_date < ${fromDate}::date
  `;
  openingPence = (priorBank[0].bal || 0) + (priorBankOpen[0].bal || 0)
               + (priorExp[0].bal || 0)  + (priorJl[0].bal || 0);
  if (code === '4000') {
    const [{ prior }] = await sql`
      SELECT COALESCE(SUM(subtotal_pence), 0)::int AS prior
      FROM erp_sales_orders
      WHERE status != 'cancelled' AND order_date < ${fromDate}::date
    `;
    openingPence += prior;
  }
  if (code === '2200') {
    const [{ prior }] = await sql`
      SELECT COALESCE(SUM(vat_pence), 0)::int AS prior
      FROM erp_sales_orders
      WHERE status != 'cancelled' AND order_date < ${fromDate}::date
    `;
    openingPence += prior;
  }

  // Postings in period — union across sources
  const postings = [];

  const bankRows = await sql`
    SELECT t.txn_date AS date, t.description, t.amount_pence,
           t.id AS src_id, 'bank' AS src_type,
           t.matched_so_id, t.matched_po_id, t.matched_expense_id
    FROM erp_bank_transactions t
    JOIN erp_bank_accounts ba ON ba.id = t.bank_account_id
    WHERE ba.nominal_account_id = ${acct.id}
      AND t.txn_date >= ${fromDate}::date AND t.txn_date <= ${toDate}::date
  `;
  for (const r of bankRows) postings.push({ ...r, amount_pence: r.amount_pence });

  const expRows = await sql`
    SELECT e.expense_date AS date,
           COALESCE(e.supplier, '') || ' — ' || e.description AS description,
           e.amount_pence, e.id AS src_id, 'expense' AS src_type
    FROM erp_expenses e
    JOIN erp_expense_categories ec ON ec.id = e.category_id
    WHERE ec.nominal_account_id = ${acct.id}
      AND e.expense_date >= ${fromDate}::date AND e.expense_date <= ${toDate}::date
  `;
  for (const r of expRows) postings.push(r);

  if (code === '4000') {
    const salesRows = await sql`
      SELECT so.order_date AS date,
             so.so_number || ' — ' || c.name AS description,
             so.subtotal_pence AS amount_pence,
             so.id AS src_id, 'sales' AS src_type
      FROM erp_sales_orders so
      JOIN erp_customers c ON c.id = so.customer_id
      WHERE so.status != 'cancelled'
        AND so.order_date >= ${fromDate}::date AND so.order_date <= ${toDate}::date
    `;
    for (const r of salesRows) postings.push(r);
  }
  if (code === '2200') {
    const vatRows = await sql`
      SELECT so.order_date AS date,
             so.so_number || ' — VAT on ' || c.name AS description,
             so.vat_pence AS amount_pence,
             so.id AS src_id, 'vat' AS src_type
      FROM erp_sales_orders so
      JOIN erp_customers c ON c.id = so.customer_id
      WHERE so.status != 'cancelled' AND so.vat_pence > 0
        AND so.order_date >= ${fromDate}::date AND so.order_date <= ${toDate}::date
    `;
    for (const r of vatRows) postings.push(r);
  }

  const jlRows = await sql`
    SELECT je.entry_date AS date,
           COALESCE(je.narrative, je.reference, 'Journal') AS description,
           (jl.debit_pence - jl.credit_pence) AS amount_pence,
           jl.id AS src_id, 'journal' AS src_type,
           je.reference AS journal_ref, je.id AS entry_id
    FROM erp_journal_lines jl
    JOIN erp_journal_entries je ON je.id = jl.entry_id
    WHERE jl.nominal_account_id = ${acct.id}
      AND je.entry_date >= ${fromDate}::date AND je.entry_date <= ${toDate}::date
  `;
  for (const r of jlRows) postings.push(r);

  // Sort + running balance
  postings.sort((a, b) => new Date(a.date) - new Date(b.date));
  let running = openingPence;
  for (const p of postings) {
    running += p.amount_pence;
    p.running_balance_pence = running;
    // Split into debit/credit columns for display
    if (p.amount_pence >= 0) { p.debit_pence = p.amount_pence; p.credit_pence = 0; }
    else                     { p.debit_pence = 0; p.credit_pence = -p.amount_pence; }
  }

  return res.status(200).json({
    ok: true,
    account: acct,
    from: fromDate, to: toDate,
    opening_balance_pence: openingPence,
    closing_balance_pence: running,
    total_debits:  postings.reduce((s,p) => s + (p.debit_pence  || 0), 0),
    total_credits: postings.reduce((s,p) => s + (p.credit_pence || 0), 0),
    postings
  });
}
