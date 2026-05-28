import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';

// MAXVAC catalogue scraped from the website (Medi 4e / 8 / 10 + consumables).
// sale_price_pence is ex-VAT (line VAT is added on the Sales Order at vat_rate_percent).
// cost_price_pence is what we pay; null leaves any existing cost untouched.
const ITEMS = [
  // SKU              name                          category    sale_ex (pence)  cost (pence)   serial?  service mths
  ['MV-MEDI-4E',      'MAXVAC Medi 4e',             'purifier',    11112,        null,           true,    null],
  ['MV-MEDI-8',       'MAXVAC Medi 8',              'purifier',    35625,        null,           true,    null],
  ['MV-MEDI-10',      'MAXVAC Medi 10',             'purifier',   120625,        null,           true,    null],
  ['MV-MEDI-4E-F',    'MAXVAC Medi 4e filter',      'filter',       5560,        null,           false,   12],
  ['MV-MEDI-4E-L',    'MAXVAC Medi 4e UV-C lamp',   'filter',       1183,        null,           false,   12],
  ['MV-MEDI-8-F',     'MAXVAC Medi 8 filter pack',  'filter',      12270,        null,           false,   12],
  ['MV-MEDI-8-L',     'MAXVAC Medi 8 UV-C lamps',   'filter',       1983,        null,           false,   12],
  ['MV-MEDI-10-F',    'MAXVAC Medi 10 filter',      'filter',      19200,       15360,           false,   12],
  ['MV-MEDI-10-L',    'MAXVAC Medi 10 UV-C lamp',   'filter',      12900,       10320,           false,   12]
];

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST required' });
  }

  // Upsert the MAXVAC supplier (creates on first run, idempotent thereafter)
  const supRows = await sql`
    INSERT INTO erp_suppliers (account_code, name, currency, created_by)
    VALUES ('MAXVAC', 'MAXVAC', 'GBP', ${user.id})
    ON CONFLICT (account_code) DO UPDATE SET
      name = EXCLUDED.name,
      updated_at = NOW()
    RETURNING id
  `;
  const manufacturerId = supRows[0]?.id || null;

  const results = [];
  for (const [sku, name, category, salePence, costPence, requiresSerial, intervalMonths] of ITEMS) {
    const rows = await sql`
      INSERT INTO erp_products (
        sku, name, brand, category, manufacturer_id,
        sale_price_pence, cost_price_pence, currency, vat_rate_percent,
        requires_serial, service_interval_months,
        country_of_origin, created_by
      ) VALUES (
        ${sku}, ${name}, 'MAXVAC', ${category}, ${manufacturerId},
        ${salePence}, ${costPence}, 'GBP', 20,
        ${requiresSerial}, ${intervalMonths},
        'GB', ${user.id}
      )
      ON CONFLICT (sku) DO UPDATE SET
        name = EXCLUDED.name,
        brand = EXCLUDED.brand,
        category = EXCLUDED.category,
        manufacturer_id = COALESCE(EXCLUDED.manufacturer_id, erp_products.manufacturer_id),
        sale_price_pence = EXCLUDED.sale_price_pence,
        cost_price_pence = COALESCE(EXCLUDED.cost_price_pence, erp_products.cost_price_pence),
        currency = 'GBP',
        vat_rate_percent = 20,
        requires_serial = EXCLUDED.requires_serial,
        service_interval_months = EXCLUDED.service_interval_months,
        country_of_origin = COALESCE(erp_products.country_of_origin, 'GB'),
        updated_at = NOW()
      RETURNING id, sku, sale_price_pence, cost_price_pence, (xmax = 0) AS inserted
    `;
    const r = rows[0];
    results.push({
      sku: r.sku,
      action: r.inserted ? 'created' : 'updated',
      cost: r.cost_price_pence == null ? null : '£' + (r.cost_price_pence / 100).toFixed(2),
      sale_ex_vat: '£' + (r.sale_price_pence / 100).toFixed(2),
      sale_inc_vat: '£' + (r.sale_price_pence * 1.2 / 100).toFixed(2)
    });
  }
  return res.status(200).json({ ok: true, supplier_id: manufacturerId, results });
}
