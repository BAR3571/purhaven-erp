import { sql } from '../../../lib/db.js';
import { requireUser } from '../../../lib/session.js';
import { getMainWarehouseId } from '../../../lib/stock.js';

function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // Handle month length rollover (e.g. 31 Jan + 1m -> 28 Feb, not 3 Mar)
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const productId = parseInt(req.query.id, 10);
  if (!Number.isFinite(productId)) return res.status(400).json({ error: 'Invalid product id' });

  if (req.method === 'GET') {
    const rows = await sql`
      SELECT s.*, c.name AS customer_name, c.account_code AS customer_code
      FROM erp_product_serials s
      LEFT JOIN erp_customers c ON c.id = s.despatched_to_customer_id
      WHERE s.product_id = ${productId}
      ORDER BY s.created_at DESC
    `;
    return res.status(200).json({ ok: true, serials: rows });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const serialNumber = (b.serial_number || '').trim();
    if (!serialNumber) return res.status(400).json({ error: 'Serial number is required' });

    const productRows = await sql`SELECT service_interval_months FROM erp_products WHERE id = ${productId}`;
    if (productRows.length === 0) return res.status(404).json({ error: 'Product not found' });
    const interval = productRows[0].service_interval_months;

    const status = ['in_stock','despatched','installed','replaced','returned','scrapped'].includes(b.status)
      ? b.status : 'in_stock';

    let warehouseId = b.warehouse_id ? parseInt(b.warehouse_id, 10) : null;
    if (status === 'in_stock' && !warehouseId) warehouseId = await getMainWarehouseId();

    const despatchedAt = b.despatched_at || null;
    let serviceDueAt = b.service_due_at || null;
    if (!serviceDueAt && despatchedAt && interval) {
      serviceDueAt = addMonths(despatchedAt, interval);
    }

    try {
      const rows = await sql`
        INSERT INTO erp_product_serials (
          product_id, serial_number, status, warehouse_id, parent_serial_id,
          received_at, despatched_at, despatched_to_customer_id,
          service_due_at, service_done_at, notes
        ) VALUES (
          ${productId}, ${serialNumber}, ${status}, ${warehouseId},
          ${b.parent_serial_id ? parseInt(b.parent_serial_id, 10) : null},
          ${b.received_at || null},
          ${despatchedAt},
          ${b.despatched_to_customer_id ? parseInt(b.despatched_to_customer_id, 10) : null},
          ${serviceDueAt},
          ${b.service_done_at || null},
          ${b.notes || null}
        )
        RETURNING *
      `;
      return res.status(201).json({ ok: true, serial: rows[0] });
    } catch (err) {
      if (err.message?.includes('erp_product_serials_product_id_serial_number_key')) {
        return res.status(409).json({ error: `Serial ${serialNumber} already exists for this product` });
      }
      return res.status(500).json({ error: err.message });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
