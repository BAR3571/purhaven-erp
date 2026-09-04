import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';

// GET /api/accounts/export?kind=X&from=YYYY-MM-DD&to=YYYY-MM-DD[&bank_account_id=N]
//
// kind values:
//   bank-txns  — bank transactions (needs bank_account_id, or omit for all accounts)
//   expenses   — expenses in the period
//   revenue    — SO revenue in the period (uses SO date and payment status)
//   pnl        — one-row-per-category P&L summary for the period
//
// Returns a plain-text CSV response (Content-Type text/csv).
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const kind = (req.query.kind || 'bank-txns').trim();
  const fromDate = req.query.from || '1900-01-01';
  const toDate = req.query.to || '2999-12-31';
  const bankId = req.query.bank_account_id ? parseInt(req.query.bank_account_id, 10) : null;

  let rows, headers, filename;

  if (kind === 'bank-txns') {
    if (bankId) {
      rows = await sql`
        SELECT ba.name AS account, ba.currency,
               t.txn_date, t.description, t.reference,
               (t.amount_pence::numeric / 100) AS amount,
               CASE WHEN t.amount_pence > 0 THEN (t.amount_pence::numeric / 100) END AS money_in,
               CASE WHEN t.amount_pence < 0 THEN (-t.amount_pence::numeric / 100) END AS money_out,
               so.so_number AS matched_so, po.po_number AS matched_po,
               ec.name AS matched_expense_category,
               CASE WHEN t.reconciled_at IS NOT NULL THEN 'YES' ELSE '' END AS reconciled,
               t.imported_from AS source
        FROM erp_bank_transactions t
        JOIN erp_bank_accounts ba ON ba.id = t.bank_account_id
        LEFT JOIN erp_sales_orders so    ON so.id = t.matched_so_id
        LEFT JOIN erp_purchase_orders po ON po.id = t.matched_po_id
        LEFT JOIN erp_expenses e         ON e.id = t.matched_expense_id
        LEFT JOIN erp_expense_categories ec ON ec.id = e.category_id
        WHERE t.bank_account_id = ${bankId}
          AND t.txn_date >= ${fromDate}::date AND t.txn_date <= ${toDate}::date
        ORDER BY t.txn_date ASC, t.id ASC
      `;
    } else {
      rows = await sql`
        SELECT ba.name AS account, ba.currency,
               t.txn_date, t.description, t.reference,
               (t.amount_pence::numeric / 100) AS amount,
               CASE WHEN t.amount_pence > 0 THEN (t.amount_pence::numeric / 100) END AS money_in,
               CASE WHEN t.amount_pence < 0 THEN (-t.amount_pence::numeric / 100) END AS money_out,
               so.so_number AS matched_so, po.po_number AS matched_po,
               ec.name AS matched_expense_category,
               CASE WHEN t.reconciled_at IS NOT NULL THEN 'YES' ELSE '' END AS reconciled,
               t.imported_from AS source
        FROM erp_bank_transactions t
        JOIN erp_bank_accounts ba ON ba.id = t.bank_account_id
        LEFT JOIN erp_sales_orders so    ON so.id = t.matched_so_id
        LEFT JOIN erp_purchase_orders po ON po.id = t.matched_po_id
        LEFT JOIN erp_expenses e         ON e.id = t.matched_expense_id
        LEFT JOIN erp_expense_categories ec ON ec.id = e.category_id
        WHERE t.txn_date >= ${fromDate}::date AND t.txn_date <= ${toDate}::date
        ORDER BY ba.name ASC, t.txn_date ASC, t.id ASC
      `;
    }
    headers = ['Account','Currency','Date','Description','Reference','Amount','Money in','Money out','Matched SO','Matched PO','Expense category','Reconciled','Source'];
    filename = `bank-txns_${fromDate}_${toDate}.csv`;
  }
  else if (kind === 'expenses') {
    rows = await sql`
      SELECT e.expense_date, ec.name AS category, e.supplier, e.description,
             (e.amount_pence::numeric / 100) AS amount,
             (e.vat_pence::numeric / 100) AS vat,
             ba.name AS paid_from_account, e.notes
      FROM erp_expenses e
      LEFT JOIN erp_expense_categories ec ON ec.id = e.category_id
      LEFT JOIN erp_bank_accounts ba ON ba.id = e.bank_account_id
      WHERE e.expense_date >= ${fromDate}::date AND e.expense_date <= ${toDate}::date
      ORDER BY e.expense_date ASC, e.id ASC
    `;
    headers = ['Date','Category','Supplier','Description','Amount','VAT','Paid from','Notes'];
    filename = `expenses_${fromDate}_${toDate}.csv`;
  }
  else if (kind === 'revenue') {
    rows = await sql`
      SELECT so.order_date, so.so_number, c.name AS customer, c.account_code AS customer_code,
             so.status, so.currency,
             (so.subtotal_pence::numeric / 100) AS subtotal_ex_vat,
             (so.vat_pence::numeric / 100) AS vat,
             (so.total_pence::numeric / 100) AS total_inc_vat,
             so.paid_at,
             (so.paid_amount_pence::numeric / 100) AS amount_paid,
             so.payment_method,
             (so.processing_fee_pence::numeric / 100) AS processing_fee,
             so.payment_ref,
             so.source
      FROM erp_sales_orders so
      JOIN erp_customers c ON c.id = so.customer_id
      WHERE so.order_date >= ${fromDate}::date AND so.order_date <= ${toDate}::date
        AND so.status != 'cancelled'
      ORDER BY so.order_date ASC, so.id ASC
    `;
    headers = ['Order date','SO number','Customer','Customer code','Status','Currency','Subtotal (ex VAT)','VAT','Total (inc VAT)','Paid at','Amount paid','Payment method','Processing fee','Payment ref','Source'];
    filename = `revenue_${fromDate}_${toDate}.csv`;
  }
  else if (kind === 'pnl') {
    // Simple one-row-per-category P&L rollup
    const revenue = await sql`
      SELECT 'Revenue' AS section, 'Sales revenue (ex VAT)' AS line,
             COALESCE(SUM(subtotal_pence)::numeric / 100, 0) AS amount
      FROM erp_sales_orders
      WHERE order_date >= ${fromDate}::date AND order_date <= ${toDate}::date AND status != 'cancelled'
    `;
    const expenses = await sql`
      SELECT 'Expenses' AS section, COALESCE(ec.name, 'Uncategorised') AS line,
             (SUM(e.amount_pence)::numeric / 100) AS amount
      FROM erp_expenses e
      LEFT JOIN erp_expense_categories ec ON ec.id = e.category_id
      WHERE e.expense_date >= ${fromDate}::date AND e.expense_date <= ${toDate}::date
      GROUP BY ec.name
      ORDER BY SUM(e.amount_pence) DESC
    `;
    rows = [...revenue, ...expenses];
    headers = ['Section','Line','Amount'];
    filename = `pnl_${fromDate}_${toDate}.csv`;
  }
  else {
    return res.status(400).json({ error: `Unknown kind: ${kind}. Expected: bank-txns, expenses, revenue, pnl.` });
  }

  // Emit CSV
  const csvRows = [headers.map(csvCell).join(',')];
  for (const r of rows) {
    const line = headers.map(h => {
      // convert header to key (snake case-ish, matching aliases)
      const key = h.toLowerCase().replace(/[()]/g,'').replace(/[ /]+/g,'_');
      // try direct match first, then simplified variations
      const val = r[key] ?? r[h.toLowerCase().replace(/\s+/g,'_')] ?? r[toKey(h)] ?? '';
      return csvCell(val);
    }).join(',');
    csvRows.push(line);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(csvRows.join('\n'));
}

function toKey(header) {
  // Map friendly header to SQL alias:
  //   'Order date' -> 'order_date'
  //   'Money in'   -> 'money_in'
  //   'Total (inc VAT)' -> 'total_inc_vat'
  //   'Amount paid' -> 'amount_paid'
  return header.toLowerCase()
    .replace(/\s+\(ex vat\)/, '_ex_vat')
    .replace(/\s+\(inc vat\)/, '_inc_vat')
    .replace(/\s+#/, '_number')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function csvCell(v) {
  if (v == null) return '';
  if (v instanceof Date) v = v.toISOString().slice(0, 10);
  const s = String(v);
  // Escape if contains comma, quote, or newline
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
