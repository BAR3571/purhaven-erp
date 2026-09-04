import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';

// GET /api/accounts/balance-sheet?as_of=YYYY-MM-DD
//
// Returns a snapshot at `as_of` (default today):
//   - Assets    (1xxx)    — bank + stock + debtors
//   - Liabilities (2xxx)  — creditors, VAT, director loan, corp tax
//   - Equity      (3xxx)  — share capital + retained earnings
//   - Retained earnings for the current financial year is added on the fly
//     from current-period Revenue - Expenses (income - cogs - overhead).
//
// Balances follow the same aggregation approach as /api/accounts/ledger:
// pulls postings from bank_transactions + bank_account opening balances +
// expenses + sales + VAT + journal lines.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);
  // Financial year = calendar year for now (customise later)
  const yr = new Date(asOf).getFullYear();
  const fyStart = `${yr}-01-01`;

  const accts = await sql`
    SELECT id, code, name, type FROM erp_nominal_accounts WHERE active = TRUE ORDER BY code ASC
  `;
  const balances = {};
  for (const a of accts) balances[a.code] = 0;

  // Bank txns
  for (const r of await sql`
    SELECT na.code, COALESCE(SUM(t.amount_pence), 0)::int AS bal
    FROM erp_bank_transactions t
    JOIN erp_bank_accounts ba ON ba.id = t.bank_account_id
    JOIN erp_nominal_accounts na ON na.id = ba.nominal_account_id
    WHERE t.txn_date <= ${asOf}::date
    GROUP BY na.code
  `) balances[r.code] = (balances[r.code] || 0) + r.bal;

  // Bank opening balances
  for (const r of await sql`
    SELECT na.code, COALESCE(SUM(ba.opening_balance_pence), 0)::int AS bal
    FROM erp_bank_accounts ba
    JOIN erp_nominal_accounts na ON na.id = ba.nominal_account_id
    GROUP BY na.code
  `) balances[r.code] = (balances[r.code] || 0) + r.bal;

  // Expenses posted through categories
  for (const r of await sql`
    SELECT na.code, COALESCE(SUM(e.amount_pence), 0)::int AS bal
    FROM erp_expenses e
    JOIN erp_expense_categories ec ON ec.id = e.category_id
    JOIN erp_nominal_accounts na   ON na.id = ec.nominal_account_id
    WHERE e.expense_date <= ${asOf}::date
    GROUP BY na.code
  `) balances[r.code] = (balances[r.code] || 0) + r.bal;

  // Sales + VAT
  const [{ sales }] = await sql`
    SELECT COALESCE(SUM(subtotal_pence), 0)::int AS sales
    FROM erp_sales_orders
    WHERE status != 'cancelled' AND order_date <= ${asOf}::date
  `;
  const [{ vat }] = await sql`
    SELECT COALESCE(SUM(vat_pence), 0)::int AS vat
    FROM erp_sales_orders
    WHERE status != 'cancelled' AND order_date <= ${asOf}::date
  `;
  balances['4000'] = (balances['4000'] || 0) + sales;
  balances['2200'] = (balances['2200'] || 0) + vat;

  // Journal lines
  for (const r of await sql`
    SELECT na.code, COALESCE(SUM(jl.debit_pence - jl.credit_pence), 0)::int AS bal
    FROM erp_journal_lines jl
    JOIN erp_journal_entries je ON je.id = jl.entry_id
    JOIN erp_nominal_accounts na ON na.id = jl.nominal_account_id
    WHERE je.entry_date <= ${asOf}::date
    GROUP BY na.code
  `) balances[r.code] = (balances[r.code] || 0) + r.bal;

  // Group by type — asset / liability / equity are on the balance sheet
  const bySection = { assets: [], liabilities: [], equity: [] };
  let totalAssets = 0, totalLiabilities = 0, totalEquity = 0;
  for (const a of accts) {
    const bal = balances[a.code] || 0;
    if (a.type === 'asset') {
      // Debit-natured — show positive as is
      if (bal !== 0) { bySection.assets.push({ ...a, balance_pence: bal }); totalAssets += bal; }
    } else if (a.type === 'liability') {
      // Credit-natured — invert sign so a credit balance shows as positive
      const inv = -bal;
      if (inv !== 0) { bySection.liabilities.push({ ...a, balance_pence: inv }); totalLiabilities += inv; }
    } else if (a.type === 'equity') {
      const inv = -bal;
      if (inv !== 0) { bySection.equity.push({ ...a, balance_pence: inv }); totalEquity += inv; }
    }
  }

  // Current-year retained earnings = revenue - cogs - overheads - other_expense - tax
  // for the current financial year up to asOf.
  const [{ ytd_sales }] = await sql`
    SELECT COALESCE(SUM(subtotal_pence), 0)::int AS ytd_sales
    FROM erp_sales_orders
    WHERE status != 'cancelled'
      AND order_date >= ${fyStart}::date AND order_date <= ${asOf}::date
  `;
  const [{ ytd_expenses }] = await sql`
    SELECT COALESCE(SUM(amount_pence), 0)::int AS ytd_expenses
    FROM erp_expenses
    WHERE expense_date >= ${fyStart}::date AND expense_date <= ${asOf}::date
  `;
  // Journal impact on P&L accounts (income + cogs + overhead + other_expense + tax)
  const [{ ytd_journal_pnl }] = await sql`
    SELECT COALESCE(SUM(
      CASE WHEN na.type = 'income'
             THEN (jl.credit_pence - jl.debit_pence)
           WHEN na.type IN ('cogs','overhead','other_expense','tax')
             THEN (jl.debit_pence - jl.credit_pence) * -1
           ELSE 0
      END
    ), 0)::int AS ytd_journal_pnl
    FROM erp_journal_lines jl
    JOIN erp_journal_entries je ON je.id = jl.entry_id
    JOIN erp_nominal_accounts na ON na.id = jl.nominal_account_id
    WHERE je.entry_date >= ${fyStart}::date AND je.entry_date <= ${asOf}::date
  `;
  const currentYearProfit = ytd_sales - ytd_expenses + (ytd_journal_pnl || 0);

  if (currentYearProfit !== 0) {
    bySection.equity.push({
      code: '3210', name: `Current-year profit (${yr})`, type: 'equity',
      balance_pence: currentYearProfit, is_computed: true
    });
    totalEquity += currentYearProfit;
  }

  const totalLiabAndEquity = totalLiabilities + totalEquity;
  const difference = totalAssets - totalLiabAndEquity;

  return res.status(200).json({
    ok: true,
    as_of: asOf,
    financial_year_start: fyStart,
    sections: bySection,
    totals: {
      assets: totalAssets,
      liabilities: totalLiabilities,
      equity: totalEquity,
      liabilities_and_equity: totalLiabAndEquity
    },
    current_year_profit_pence: currentYearProfit,
    difference_pence: difference,
    balances: difference === 0
  });
}
