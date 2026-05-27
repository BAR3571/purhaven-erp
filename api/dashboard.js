import { sql } from '../lib/db.js';
import { requireUser } from '../lib/session.js';

// Quick KPI tile values for the Warehouse dashboard.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rows = await sql`
    SELECT
      (SELECT COUNT(*) FROM erp_despatches WHERE status = 'pending')     AS pending_picks,
      (SELECT COUNT(*) FROM erp_despatches WHERE status = 'picking')     AS in_picking,
      (SELECT COUNT(*) FROM erp_despatches WHERE status = 'packed')      AS packed,
      (SELECT COUNT(*) FROM erp_despatches
        WHERE status = 'despatched' AND despatched_at::date = CURRENT_DATE) AS despatched_today,
      (SELECT COUNT(*) FROM erp_despatches
        WHERE status = 'despatched'
          AND despatched_at >= date_trunc('week', CURRENT_DATE)) AS despatched_this_week,
      (SELECT COUNT(*) FROM erp_sales_orders WHERE status IN ('confirmed','picking','part_despatched')) AS open_sales_orders,
      (SELECT COUNT(*) FROM erp_purchase_orders WHERE status IN ('released','part_received')) AS open_purchase_orders,
      (SELECT COUNT(*) FROM erp_products
        WHERE active = TRUE
          AND min_stock_level > 0
          AND COALESCE(
            (SELECT SUM(qty_on_hand - qty_allocated) FROM erp_stock_levels WHERE product_id = erp_products.id),
            0
          ) <= min_stock_level) AS low_stock_skus,
      (SELECT COUNT(*) FROM erp_product_serials
        WHERE status IN ('despatched','installed')
          AND service_due_at IS NOT NULL
          AND service_due_at <= CURRENT_DATE + INTERVAL '30 days') AS service_due_30d
  `;

  return res.status(200).json({ ok: true, ...rows[0] });
}
