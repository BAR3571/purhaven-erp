import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';
import { getMainWarehouseId, ensureStockRow } from '../../lib/stock.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const q = (req.query.q || '').trim();
    const category = (req.query.category || '').trim() || null;
    const brand = (req.query.brand || '').trim() || null;
    const includeInactive = req.query.includeInactive === '1';
    const likeQ = q ? '%' + q + '%' : null;

    const rows = await sql`
      SELECT
        p.*,
        s.name AS manufacturer_name,
        COALESCE((
          SELECT SUM(qty_on_hand) FROM erp_stock_levels WHERE product_id = p.id
        ), 0) AS qty_on_hand_total,
        COALESCE((
          SELECT SUM(qty_allocated) FROM erp_stock_levels WHERE product_id = p.id
        ), 0) AS qty_allocated_total
      FROM erp_products p
      LEFT JOIN erp_suppliers s ON s.id = p.manufacturer_id
      WHERE (${includeInactive} OR p.active = TRUE)
        AND (${likeQ}::text IS NULL
             OR p.name ILIKE ${likeQ}
             OR p.sku ILIKE ${likeQ}
             OR p.barcode ILIKE ${likeQ})
        AND (${category}::text IS NULL OR p.category = ${category})
        AND (${brand}::text IS NULL OR p.brand = ${brand})
      ORDER BY p.brand ASC, p.name ASC
    `;
    return res.status(200).json({ ok: true, products: rows });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const sku = (b.sku || '').trim().toUpperCase();
    const name = (b.name || '').trim();
    if (!sku) return res.status(400).json({ error: 'SKU is required' });
    if (!name) return res.status(400).json({ error: 'Name is required' });

    try {
      const rows = await sql`
        INSERT INTO erp_products (
          sku, name, description, category, brand, parent_id, manufacturer_id,
          barcode, ean, hs_code, country_of_origin,
          weight_g, width_mm, height_mm, depth_mm, lead_time_weeks,
          vat_rate_percent, cost_price_pence, sale_price_pence, currency,
          min_stock_level, notes, created_by
        ) VALUES (
          ${sku}, ${name}, ${b.description || null}, ${b.category || null}, ${b.brand || null},
          ${b.parent_id || null}, ${b.manufacturer_id || null},
          ${b.barcode || null}, ${b.ean || null}, ${b.hs_code || null}, ${b.country_of_origin || null},
          ${b.weight_g ?? null}, ${b.width_mm ?? null}, ${b.height_mm ?? null}, ${b.depth_mm ?? null},
          ${b.lead_time_weeks ?? null},
          ${b.vat_rate_percent ?? 20}, ${b.cost_price_pence ?? null}, ${b.sale_price_pence ?? null},
          ${b.currency || 'GBP'},
          ${b.min_stock_level ?? 0}, ${b.notes || null}, ${user.id}
        )
        RETURNING *
      `;
      const product = rows[0];

      // Ensure a stock_levels row exists at MAIN warehouse with qty 0
      const mainId = await getMainWarehouseId();
      if (mainId) await ensureStockRow(product.id, mainId);

      return res.status(201).json({ ok: true, product });
    } catch (err) {
      if (err.message?.includes('erp_products_sku_key')) {
        return res.status(409).json({ error: `SKU ${sku} already exists` });
      }
      return res.status(500).json({ error: err.message });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
