import { sql } from '../../../lib/db.js';

// Public read-only product catalogue for the purhaven.co.uk website.
// No auth required, but cached at the edge for 5 minutes so spikes don't
// hammer the DB. CORS open to any origin — these prices are public anyway.

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  setCors(res);

  const brand = (req.query.brand || '').trim() || null;
  const category = (req.query.category || '').trim() || null;
  const sku = (req.query.sku || '').trim() || null;

  const rows = await sql`
    SELECT
      p.id, p.sku, p.name, p.brand, p.category,
      p.description, p.image_url, p.parent_id,
      p.sale_price_pence, p.vat_rate_percent, p.currency,
      p.weight_g, p.hs_code, p.country_of_origin,
      p.service_interval_months, p.requires_serial,
      parent.sku AS parent_sku
    FROM erp_products p
    LEFT JOIN erp_products parent ON parent.id = p.parent_id
    WHERE p.active = TRUE
      AND p.sale_price_pence IS NOT NULL
      AND (${sku}::text IS NULL OR p.sku = ${sku})
      AND (${brand}::text IS NULL OR p.brand = ${brand})
      AND (${category}::text IS NULL OR p.category = ${category})
    ORDER BY p.brand ASC, p.name ASC
  `;

  // Add a couple of convenience computed fields so callers don't have to do maths
  const products = rows.map(p => {
    const ex = p.sale_price_pence;
    const vatRate = p.vat_rate_percent ?? 20;
    const inc = Math.round(ex * (1 + vatRate / 100));
    return {
      ...p,
      sale_price_pence_inc_vat: inc,
      sale_price_display_inc_vat: '£' + (inc / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      sale_price_display_ex_vat:  '£' + (ex  / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    };
  });

  // Edge cache for 5 minutes; allow stale-while-revalidate for 1 day
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
  return res.status(200).json({ ok: true, products });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}
