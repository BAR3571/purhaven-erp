import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';

// MedicAir RRPs supplied 2026-05-27.
// sale_price_pence is ex-VAT (line VAT is added on the Sales Order at vat_rate_percent).
const ITEMS = [
  // SKU              name                              category    sale_ex (pence)  serial?  service mths
  ['MA-PRO-MINI',     'MedicAir Pro Mini',              'purifier',     53250,        true,    null],
  ['MA-PRO',          'MedicAir Pro',                   'purifier',    113250,        true,    null],
  ['MA-PRO-MAX',      'MedicAir Pro Max',               'purifier',    224917,        true,    null],
  ['MA-PRO-MINI-F',   'MedicAir Pro Mini filter',       'filter',       10750,        false,   12],
  ['MA-PRO-F',        'MedicAir Pro filter',            'filter',       16583,        false,   12],
  ['MA-PRO-MAX-F',    'MedicAir Pro Max filter',        'filter',       24917,        false,   12],
  ['MA-WHEELED-BASE', 'MedicAir Pro wheeled base',      'accessory',     8250,        false,   null],
  ['MA-WALL-MOUNT',   'MedicAir Pro wall mount',        'accessory',     6583,        false,   null]
];

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST required' });
  }

  // Find MedicAir supplier (defaults to whichever supplier matches "MedicAir")
  const supRows = await sql`SELECT id FROM erp_suppliers WHERE name ILIKE 'MedicAir%' LIMIT 1`;
  const manufacturerId = supRows[0]?.id || null;

  const results = [];
  for (const [sku, name, category, salePence, requiresSerial, intervalMonths] of ITEMS) {
    const rows = await sql`
      INSERT INTO erp_products (
        sku, name, brand, category, manufacturer_id,
        sale_price_pence, currency, vat_rate_percent,
        requires_serial, service_interval_months,
        country_of_origin, created_by
      ) VALUES (
        ${sku}, ${name}, 'MedicAir', ${category}, ${manufacturerId},
        ${salePence}, 'GBP', 20,
        ${requiresSerial}, ${intervalMonths},
        'GB', ${user.id}
      )
      ON CONFLICT (sku) DO UPDATE SET
        name = EXCLUDED.name,
        brand = EXCLUDED.brand,
        category = EXCLUDED.category,
        manufacturer_id = COALESCE(EXCLUDED.manufacturer_id, erp_products.manufacturer_id),
        sale_price_pence = EXCLUDED.sale_price_pence,
        currency = 'GBP',
        vat_rate_percent = 20,
        requires_serial = EXCLUDED.requires_serial,
        service_interval_months = EXCLUDED.service_interval_months,
        country_of_origin = COALESCE(erp_products.country_of_origin, 'GB'),
        updated_at = NOW()
      RETURNING id, sku, sale_price_pence, (xmax = 0) AS inserted
    `;
    const r = rows[0];
    results.push({
      sku: r.sku,
      action: r.inserted ? 'created' : 'updated',
      sale_ex_vat: '£' + (r.sale_price_pence / 100).toFixed(2),
      sale_inc_vat: '£' + (r.sale_price_pence * 1.2 / 100).toFixed(2)
    });
  }
  return res.status(200).json({ ok: true, results });
}
