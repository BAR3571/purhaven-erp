import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';

// GET /api/accounts/pnl?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns a month-by-month P&L for the requested range plus totals and a
// category breakdown for expenses. Everything defaults to year-to-date if
// no dates are given.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const today = new Date();
  const y = today.getUTCFullYear();
  const ytdFrom = new Date(Date.UTC(y, 0, 1)).toISOString().slice(0, 10);
  const from = req.query.from || ytdFrom;
  const to   = req.query.to   || today.toISOString().slice(0, 10);

  // Monthly revenue from SOs
  const revenue = await sql`
    SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS month,
           COALESCE(SUM(subtotal_pence), 0)::bigint AS revenue_pence
    FROM erp_sales_orders
    WHERE status NOT IN ('draft','cancelled')
      AND order_date >= ${from} AND order_date <= ${to}
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  // Monthly COGS from SO lines (product.cost_price_pence * quantity_ordered)
  const cogs = await sql`
    SELECT to_char(date_trunc('month', so.order_date), 'YYYY-MM') AS month,
           COALESCE(SUM(sol.quantity_ordered * COALESCE(p.cost_price_pence, 0)), 0)::bigint AS cogs_pence
    FROM erp_sales_order_lines sol
    JOIN erp_sales_orders so ON so.id = sol.so_id
    LEFT JOIN erp_products p ON p.id = sol.product_id
    WHERE so.status NOT IN ('draft','cancelled')
      AND so.order_date >= ${from} AND so.order_date <= ${to}
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  // Monthly overhead expenses
  const expenses = await sql`
    SELECT to_char(date_trunc('month', expense_date), 'YYYY-MM') AS month,
           COALESCE(SUM(amount_pence), 0)::bigint AS expenses_pence
    FROM erp_expenses
    WHERE expense_date >= ${from} AND expense_date <= ${to}
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  // Category breakdown for the whole period (useful in the report footer)
  const byCategory = await sql`
    SELECT COALESCE(ec.name, 'Uncategorised') AS category,
           COALESCE(SUM(e.amount_pence), 0)::bigint AS amount_pence,
           COUNT(*) AS count
    FROM erp_expenses e
    LEFT JOIN erp_expense_categories ec ON ec.id = e.category_id
    WHERE e.expense_date >= ${from} AND e.expense_date <= ${to}
    GROUP BY ec.name
    ORDER BY amount_pence DESC
  `;

  // Merge the three monthly series into one array keyed by month
  const months = new Map();
  const merge = (rows, key) => {
    for (const r of rows) {
      const m = months.get(r.month) || { month: r.month, revenue_pence: 0, cogs_pence: 0, expenses_pence: 0 };
      m[key] = Number(r[key]);
      months.set(r.month, m);
    }
  };
  merge(revenue, 'revenue_pence');
  merge(cogs,    'cogs_pence');
  merge(expenses,'expenses_pence');
  const rows = [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(m => ({
      ...m,
      gross_profit_pence: m.revenue_pence - m.cogs_pence,
      net_profit_pence:   m.revenue_pence - m.cogs_pence - m.expenses_pence
    }));

  const totals = rows.reduce((s, r) => ({
    revenue_pence:      s.revenue_pence      + r.revenue_pence,
    cogs_pence:         s.cogs_pence         + r.cogs_pence,
    expenses_pence:     s.expenses_pence     + r.expenses_pence,
    gross_profit_pence: s.gross_profit_pence + r.gross_profit_pence,
    net_profit_pence:   s.net_profit_pence   + r.net_profit_pence
  }), { revenue_pence:0, cogs_pence:0, expenses_pence:0, gross_profit_pence:0, net_profit_pence:0 });

  return res.status(200).json({
    ok: true,
    period: { from, to },
    months: rows,
    totals,
    expenses_by_category: byCategory
  });
}
