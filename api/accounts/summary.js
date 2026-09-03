import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';

// GET /api/accounts/summary
// Snapshot for the Accounts dashboard: cash across all bank accounts,
// month-to-date + year-to-date revenue, COGS, expenses and net profit.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Cash position per bank account + total
  const banks = await sql`
    SELECT ba.id, ba.name, ba.provider, ba.currency, ba.opening_balance_pence,
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
  const totalCashPence = banks.reduce((s, b) => s + Number(b.current_balance_pence || 0), 0);

  // Helpers to build month-to-date + year-to-date buckets in one query each
  async function periodTotals(fromIso, toIso) {
    // Revenue (from confirmed SOs, ex-VAT subtotal so it's true trading revenue)
    const [rev] = await sql`
      SELECT COALESCE(SUM(subtotal_pence), 0)::bigint AS revenue_pence,
             COUNT(*) AS order_count
      FROM erp_sales_orders
      WHERE status NOT IN ('draft','cancelled')
        AND order_date >= ${fromIso} AND order_date <= ${toIso}
    `;
    // COGS: sum of qty * product cost across SO lines whose SO falls in period
    const [cogs] = await sql`
      SELECT COALESCE(SUM(sol.quantity_ordered * COALESCE(p.cost_price_pence, 0)), 0)::bigint AS cogs_pence
      FROM erp_sales_order_lines sol
      JOIN erp_sales_orders so ON so.id = sol.so_id
      LEFT JOIN erp_products p ON p.id = sol.product_id
      WHERE so.status NOT IN ('draft','cancelled')
        AND so.order_date >= ${fromIso} AND so.order_date <= ${toIso}
    `;
    // Overheads: everything in erp_expenses in the period
    const [ovh] = await sql`
      SELECT COALESCE(SUM(amount_pence), 0)::bigint AS expenses_pence,
             COUNT(*) AS expense_count
      FROM erp_expenses
      WHERE expense_date >= ${fromIso} AND expense_date <= ${toIso}
    `;
    const revenue  = Number(rev.revenue_pence);
    const cogsVal  = Number(cogs.cogs_pence);
    const expenses = Number(ovh.expenses_pence);
    return {
      revenue_pence: revenue,
      cogs_pence: cogsVal,
      expenses_pence: expenses,
      gross_profit_pence: revenue - cogsVal,
      net_profit_pence: revenue - cogsVal - expenses,
      order_count: Number(rev.order_count),
      expense_count: Number(ovh.expense_count)
    };
  }

  const today = new Date();
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const mtdFrom = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const ytdFrom = new Date(Date.UTC(y, 0, 1)).toISOString().slice(0, 10);
  const todayIso = today.toISOString().slice(0, 10);

  const [mtd, ytd] = await Promise.all([
    periodTotals(mtdFrom, todayIso),
    periodTotals(ytdFrom, todayIso)
  ]);

  return res.status(200).json({
    ok: true,
    as_of: todayIso,
    cash: {
      total_pence: totalCashPence,
      accounts: banks
    },
    mtd,
    ytd
  });
}
