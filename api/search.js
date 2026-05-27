import { sql } from '../lib/db.js';
import { requireUser } from '../lib/session.js';

// Global "search everywhere" — currently spans customers + suppliers.
// More entity types (products, sales orders, purchase orders, despatches)
// will be UNION'd in here as those modules ship.

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.status(200).json({ ok: true, results: [] });

  const like = '%' + q + '%';
  const limit = 20;

  const results = await sql`
    SELECT * FROM (
      SELECT
        'customer'    AS type,
        id::text      AS id,
        name          AS label,
        account_code  AS sub,
        '/customers/detail?id=' || id AS href,
        CASE
          WHEN account_code ILIKE ${like} THEN 1
          WHEN name ILIKE ${q + '%'}      THEN 2
          ELSE 3
        END AS rank
      FROM erp_customers
      WHERE active = TRUE
        AND (name ILIKE ${like} OR account_code ILIKE ${like} OR vat_number ILIKE ${like})

      UNION ALL

      SELECT
        'supplier'    AS type,
        id::text      AS id,
        name          AS label,
        account_code  AS sub,
        '/suppliers/detail?id=' || id AS href,
        CASE
          WHEN account_code ILIKE ${like} THEN 1
          WHEN name ILIKE ${q + '%'}      THEN 2
          ELSE 3
        END AS rank
      FROM erp_suppliers
      WHERE active = TRUE
        AND (name ILIKE ${like} OR account_code ILIKE ${like} OR vat_number ILIKE ${like})

      UNION ALL

      SELECT
        'product'     AS type,
        id::text      AS id,
        name          AS label,
        sku           AS sub,
        '/products/detail?id=' || id AS href,
        CASE
          WHEN sku ILIKE ${like}     THEN 1
          WHEN name ILIKE ${q + '%'} THEN 2
          ELSE 3
        END AS rank
      FROM erp_products
      WHERE active = TRUE
        AND (name ILIKE ${like} OR sku ILIKE ${like} OR barcode ILIKE ${like} OR ean ILIKE ${like})

      UNION ALL

      SELECT
        'sales_order' AS type,
        so.id::text   AS id,
        c.name        AS label,
        so.so_number  AS sub,
        '/orders/sales-orders/detail?id=' || so.id AS href,
        CASE
          WHEN so.so_number ILIKE ${like} THEN 1
          WHEN so.customer_ref ILIKE ${like} THEN 2
          ELSE 3
        END AS rank
      FROM erp_sales_orders so
      JOIN erp_customers c ON c.id = so.customer_id
      WHERE so.so_number ILIKE ${like}
         OR so.customer_ref ILIKE ${like}
         OR c.name ILIKE ${like}

      UNION ALL

      SELECT
        'purchase_order' AS type,
        po.id::text      AS id,
        s.name           AS label,
        po.po_number     AS sub,
        '/orders/purchase-orders/detail?id=' || po.id AS href,
        CASE
          WHEN po.po_number ILIKE ${like} THEN 1
          WHEN po.supplier_ref ILIKE ${like} THEN 2
          ELSE 3
        END AS rank
      FROM erp_purchase_orders po
      JOIN erp_suppliers s ON s.id = po.supplier_id
      WHERE po.po_number ILIKE ${like}
         OR po.supplier_ref ILIKE ${like}
         OR s.name ILIKE ${like}
    ) hits
    ORDER BY rank ASC, label ASC
    LIMIT ${limit}
  `;

  return res.status(200).json({ ok: true, results });
}
