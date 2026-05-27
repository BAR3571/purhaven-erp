import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';
import { getProductWithRelations } from '../../lib/stock.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  if (req.method === 'GET') {
    const product = await getProductWithRelations(id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    return res.status(200).json({ ok: true, product });
  }

  if (req.method === 'PUT') {
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const rows = await sql`
      UPDATE erp_products SET
        name = ${name},
        description = ${b.description || null},
        category = ${b.category || null},
        brand = ${b.brand || null},
        parent_id = ${b.parent_id || null},
        manufacturer_id = ${b.manufacturer_id || null},
        barcode = ${b.barcode || null},
        ean = ${b.ean || null},
        hs_code = ${b.hs_code || null},
        country_of_origin = ${b.country_of_origin || null},
        weight_g = ${b.weight_g ?? null},
        width_mm = ${b.width_mm ?? null},
        height_mm = ${b.height_mm ?? null},
        depth_mm = ${b.depth_mm ?? null},
        lead_time_weeks = ${b.lead_time_weeks ?? null},
        vat_rate_percent = ${b.vat_rate_percent ?? 20},
        cost_price_pence = ${b.cost_price_pence ?? null},
        sale_price_pence = ${b.sale_price_pence ?? null},
        currency = ${b.currency || 'GBP'},
        min_stock_level = ${b.min_stock_level ?? 0},
        notes = ${b.notes || null},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    return res.status(200).json({ ok: true, product: rows[0] });
  }

  if (req.method === 'DELETE') {
    const rows = await sql`
      UPDATE erp_products SET active = FALSE, updated_at = NOW()
      WHERE id = ${id}
      RETURNING id
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
