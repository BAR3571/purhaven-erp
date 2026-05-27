import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';

// Phase 1 reports — return as JSON by default, ?format=csv for spreadsheets.
// Each report defines its own columns (array of [label, formatter]) so the
// frontend can render generically.

const REPORTS = {
  'sales-by-customer': {
    label: 'Sales by customer',
    description: 'Revenue per customer for the selected period. Excludes draft and cancelled orders.',
    columns: [
      ['Customer',  r => r.customer_name],
      ['Code',      r => r.customer_code],
      ['Orders',    r => Number(r.orders)],
      ['Subtotal',  r => money(r.subtotal)],
      ['VAT',       r => money(r.vat)],
      ['Total',     r => money(r.total)]
    ],
    fetch: async ({ from, to }) => sql`
      SELECT c.name AS customer_name, c.account_code AS customer_code,
             COUNT(so.id) AS orders,
             COALESCE(SUM(so.subtotal_pence), 0) AS subtotal,
             COALESCE(SUM(so.vat_pence), 0) AS vat,
             COALESCE(SUM(so.total_pence), 0) AS total
      FROM erp_sales_orders so
      JOIN erp_customers c ON c.id = so.customer_id
      WHERE so.status NOT IN ('draft', 'cancelled')
        AND (${from}::date IS NULL OR so.order_date >= ${from})
        AND (${to}::date IS NULL OR so.order_date <= ${to})
      GROUP BY c.id, c.name, c.account_code
      ORDER BY total DESC, c.name ASC
    `
  },

  'sales-by-month': {
    label: 'Sales by month',
    description: 'Order count and value grouped by calendar month.',
    columns: [
      ['Month',     r => r.month_label],
      ['Orders',    r => Number(r.orders)],
      ['Subtotal',  r => money(r.subtotal)],
      ['VAT',       r => money(r.vat)],
      ['Total',     r => money(r.total)]
    ],
    fetch: async ({ from, to }) => sql`
      SELECT
        to_char(date_trunc('month', so.order_date), 'YYYY-MM') AS month_label,
        COUNT(so.id) AS orders,
        COALESCE(SUM(so.subtotal_pence), 0) AS subtotal,
        COALESCE(SUM(so.vat_pence), 0) AS vat,
        COALESCE(SUM(so.total_pence), 0) AS total
      FROM erp_sales_orders so
      WHERE so.status NOT IN ('draft', 'cancelled')
        AND (${from}::date IS NULL OR so.order_date >= ${from})
        AND (${to}::date IS NULL OR so.order_date <= ${to})
      GROUP BY 1
      ORDER BY 1 DESC
    `
  },

  'sales-by-product': {
    label: 'Sales by product',
    description: 'Top SKUs by quantity and revenue. Lines from confirmed orders onwards.',
    columns: [
      ['SKU',         r => r.sku],
      ['Description', r => r.description],
      ['Qty sold',    r => Number(r.qty_sold)],
      ['Revenue',     r => money(r.revenue)]
    ],
    fetch: async ({ from, to }) => sql`
      SELECT sol.sku, MAX(sol.description) AS description,
             COALESCE(SUM(sol.quantity_ordered), 0) AS qty_sold,
             COALESCE(SUM(
               sol.quantity_ordered * sol.unit_price_pence
               * (1 - sol.discount_percent / 100)
             )::bigint, 0) AS revenue
      FROM erp_sales_order_lines sol
      JOIN erp_sales_orders so ON so.id = sol.so_id
      WHERE so.status NOT IN ('draft', 'cancelled')
        AND (${from}::date IS NULL OR so.order_date >= ${from})
        AND (${to}::date IS NULL OR so.order_date <= ${to})
      GROUP BY sol.sku
      ORDER BY revenue DESC, qty_sold DESC
    `
  },

  'outstanding-so-lines': {
    label: 'Outstanding SO lines',
    description: 'Lines on active orders where ordered qty exceeds qty despatched.',
    columns: [
      ['SO #',          r => r.so_number],
      ['Customer',      r => r.customer_name],
      ['Order date',    r => fmtDate(r.order_date)],
      ['Required',      r => fmtDate(r.required_date)],
      ['SKU',           r => r.sku],
      ['Description',   r => r.description],
      ['Ordered',       r => Number(r.quantity_ordered)],
      ['Despatched',    r => Number(r.quantity_despatched)],
      ['Outstanding',   r => Number(r.outstanding)]
    ],
    fetch: async ({ from, to }) => sql`
      SELECT so.so_number, c.name AS customer_name,
             so.order_date, so.required_date,
             sol.sku, sol.description,
             sol.quantity_ordered, sol.quantity_despatched,
             (sol.quantity_ordered - sol.quantity_despatched) AS outstanding
      FROM erp_sales_order_lines sol
      JOIN erp_sales_orders so ON so.id = sol.so_id
      JOIN erp_customers c ON c.id = so.customer_id
      WHERE so.status IN ('confirmed','picking','part_despatched','on_hold')
        AND sol.quantity_ordered > sol.quantity_despatched
        AND (${from}::date IS NULL OR so.order_date >= ${from})
        AND (${to}::date IS NULL OR so.order_date <= ${to})
      ORDER BY so.required_date NULLS LAST, so.order_date ASC
    `
  },

  'despatch-summary': {
    label: 'Despatch summary',
    description: 'All despatches with status, carrier and tracking details.',
    columns: [
      ['DN',          r => r.despatch_number],
      ['SO',          r => r.so_number],
      ['Customer',    r => r.customer_name],
      ['Despatched',  r => fmtDate(r.despatched_at)],
      ['Carrier',     r => r.carrier],
      ['Tracking',    r => r.tracking_number],
      ['Packages',    r => Number(r.number_of_packages)],
      ['Weight kg',   r => r.weight_kg],
      ['Status',      r => r.status]
    ],
    fetch: async ({ from, to }) => sql`
      SELECT dn.despatch_number, so.so_number, c.name AS customer_name,
             dn.despatched_at, dn.carrier, dn.tracking_number,
             dn.number_of_packages, dn.weight_kg, dn.status
      FROM erp_despatches dn
      JOIN erp_sales_orders so ON so.id = dn.so_id
      JOIN erp_customers c ON c.id = so.customer_id
      WHERE (${from}::date IS NULL OR dn.created_at::date >= ${from})
        AND (${to}::date   IS NULL OR dn.created_at::date <= ${to})
      ORDER BY dn.created_at DESC
    `
  },

  'purchase-by-supplier': {
    label: 'Purchase by supplier',
    description: 'Spend per supplier on released or received POs in the selected period.',
    columns: [
      ['Supplier',    r => r.supplier_name],
      ['Code',        r => r.supplier_code],
      ['POs',         r => Number(r.pos)],
      ['Subtotal',    r => money(r.subtotal)],
      ['VAT',         r => money(r.vat)],
      ['Total',       r => money(r.total)]
    ],
    fetch: async ({ from, to }) => sql`
      SELECT s.name AS supplier_name, s.account_code AS supplier_code,
             COUNT(po.id) AS pos,
             COALESCE(SUM(po.subtotal_pence), 0) AS subtotal,
             COALESCE(SUM(po.vat_pence), 0) AS vat,
             COALESCE(SUM(po.total_pence), 0) AS total
      FROM erp_purchase_orders po
      JOIN erp_suppliers s ON s.id = po.supplier_id
      WHERE po.status IN ('released', 'part_received', 'received', 'closed')
        AND (${from}::date IS NULL OR po.order_date >= ${from})
        AND (${to}::date   IS NULL OR po.order_date <= ${to})
      GROUP BY s.id, s.name, s.account_code
      ORDER BY total DESC, s.name ASC
    `
  },

  'low-stock': {
    label: 'Low stock',
    description: 'Active SKUs at or below their min_stock_level (available qty = on hand − allocated).',
    columns: [
      ['SKU',         r => r.sku],
      ['Name',        r => r.name],
      ['Brand',       r => r.brand],
      ['On hand',     r => Number(r.on_hand)],
      ['Allocated',   r => Number(r.allocated)],
      ['Available',   r => Number(r.available)],
      ['Min level',   r => Number(r.min_stock_level)],
      ['Short by',    r => Math.max(0, Number(r.min_stock_level) - Number(r.available))]
    ],
    fetch: async () => sql`
      SELECT p.sku, p.name, p.brand, p.min_stock_level,
             COALESCE(SUM(sl.qty_on_hand), 0) AS on_hand,
             COALESCE(SUM(sl.qty_allocated), 0) AS allocated,
             COALESCE(SUM(sl.qty_on_hand - sl.qty_allocated), 0) AS available
      FROM erp_products p
      LEFT JOIN erp_stock_levels sl ON sl.product_id = p.id
      WHERE p.active = TRUE AND p.min_stock_level > 0
      GROUP BY p.id, p.sku, p.name, p.brand, p.min_stock_level
      HAVING COALESCE(SUM(sl.qty_on_hand - sl.qty_allocated), 0) <= p.min_stock_level
      ORDER BY (p.min_stock_level - COALESCE(SUM(sl.qty_on_hand - sl.qty_allocated), 0)) DESC, p.sku ASC
    `
  },

  'service-due': {
    label: 'Service due',
    description: 'Serialised units in the field whose service_due_at falls within the next 90 days (or already overdue).',
    columns: [
      ['Serial',         r => r.serial_number],
      ['SKU',            r => r.sku],
      ['Customer',       r => r.customer_name],
      ['Despatched',     r => fmtDate(r.despatched_at)],
      ['Service due',    r => fmtDate(r.service_due_at)],
      ['Days from today',r => r.days_to_due == null ? '' : Number(r.days_to_due)]
    ],
    fetch: async () => sql`
      SELECT s.serial_number, p.sku, c.name AS customer_name,
             s.despatched_at, s.service_due_at,
             (s.service_due_at - CURRENT_DATE) AS days_to_due
      FROM erp_product_serials s
      JOIN erp_products p ON p.id = s.product_id
      LEFT JOIN erp_customers c ON c.id = s.despatched_to_customer_id
      WHERE s.status IN ('despatched','installed')
        AND s.service_due_at IS NOT NULL
        AND s.service_due_at <= CURRENT_DATE + INTERVAL '90 days'
      ORDER BY s.service_due_at ASC
    `
  }
};

function money(pence) {
  if (pence == null) return '£0.00';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(pence) / 100);
}
function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-GB');
}
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = (req.query.key || '').trim();
  const def = REPORTS[key];
  if (!def) return res.status(404).json({ error: `Unknown report: ${key}` });

  const from = req.query.from || null;
  const to   = req.query.to   || null;

  let rows;
  try {
    rows = await def.fetch({ from, to });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const data = rows.map(r => def.columns.map(([, fn]) => fn(r)));
  const columns = def.columns.map(([label]) => label);

  if ((req.query.format || '').toLowerCase() === 'csv') {
    const csv = [
      columns.map(csvCell).join(','),
      ...data.map(row => row.map(csvCell).join(','))
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${key}-${new Date().toISOString().slice(0,10)}.csv"`);
    return res.status(200).send(csv);
  }

  return res.status(200).json({
    ok: true,
    key,
    label: def.label,
    description: def.description,
    columns,
    rows: data,
    raw_rows: rows  // included for the UI to use specific fields if needed
  });
}

export const REPORT_KEYS = Object.keys(REPORTS);
