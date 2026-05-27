import { sql } from './db.js';

export async function getMainWarehouseId() {
  const rows = await sql`SELECT id FROM erp_warehouses WHERE code = 'MAIN' LIMIT 1`;
  return rows[0]?.id || null;
}

export async function ensureStockRow(productId, warehouseId) {
  await sql`
    INSERT INTO erp_stock_levels (product_id, warehouse_id)
    VALUES (${productId}, ${warehouseId})
    ON CONFLICT (product_id, warehouse_id) DO NOTHING
  `;
}

/**
 * Adjust stock on hand by delta. Positive = receipt-style, negative = despatch-style.
 * Writes both the level update and the movement log row.
 * Returns the new on-hand qty.
 */
export async function adjustStock({ productId, warehouseId, delta, movementType, referenceType, referenceId, notes, userId }) {
  await ensureStockRow(productId, warehouseId);

  const rows = await sql`
    UPDATE erp_stock_levels
    SET qty_on_hand = qty_on_hand + ${delta}, updated_at = NOW()
    WHERE product_id = ${productId} AND warehouse_id = ${warehouseId}
    RETURNING qty_on_hand
  `;

  await sql`
    INSERT INTO erp_stock_movements (
      product_id, warehouse_id, movement_type, qty,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      ${productId}, ${warehouseId}, ${movementType}, ${delta},
      ${referenceType || null}, ${referenceId || null}, ${notes || null}, ${userId || null}
    )
  `;

  return rows[0]?.qty_on_hand ?? null;
}

export async function getProductWithRelations(id) {
  const rows = await sql`
    SELECT p.*, s.name AS manufacturer_name, s.account_code AS manufacturer_code,
           parent.sku AS parent_sku, parent.name AS parent_name
    FROM erp_products p
    LEFT JOIN erp_suppliers s ON s.id = p.manufacturer_id
    LEFT JOIN erp_products parent ON parent.id = p.parent_id
    WHERE p.id = ${id}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const product = rows[0];

  const stock = await sql`
    SELECT sl.*, w.code AS warehouse_code, w.name AS warehouse_name
    FROM erp_stock_levels sl
    JOIN erp_warehouses w ON w.id = sl.warehouse_id
    WHERE sl.product_id = ${id}
    ORDER BY w.code ASC
  `;

  const movements = await sql`
    SELECT sm.*, w.code AS warehouse_code, u.email AS user_email
    FROM erp_stock_movements sm
    JOIN erp_warehouses w ON w.id = sm.warehouse_id
    LEFT JOIN erp_users u ON u.id = sm.created_by
    WHERE sm.product_id = ${id}
    ORDER BY sm.created_at DESC
    LIMIT 50
  `;

  const children = await sql`
    SELECT id, sku, name, category FROM erp_products
    WHERE parent_id = ${id} AND active = TRUE
    ORDER BY name ASC
  `;

  return { ...product, stock, movements, children };
}
