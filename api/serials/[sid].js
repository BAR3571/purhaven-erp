import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';

function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const sid = parseInt(req.query.sid, 10);
  if (!Number.isFinite(sid)) return res.status(400).json({ error: 'Invalid serial id' });

  if (req.method === 'PUT') {
    const b = req.body || {};
    const existing = await sql`
      SELECT s.*, p.service_interval_months
      FROM erp_product_serials s
      JOIN erp_products p ON p.id = s.product_id
      WHERE s.id = ${sid} LIMIT 1
    `;
    if (existing.length === 0) return res.status(404).json({ error: 'Serial not found' });
    const e = existing[0];

    const status = ['in_stock','despatched','installed','replaced','returned','scrapped'].includes(b.status)
      ? b.status : e.status;

    const despatchedAt = b.despatched_at === undefined ? e.despatched_at : (b.despatched_at || null);
    let serviceDueAt = b.service_due_at === undefined ? e.service_due_at : (b.service_due_at || null);
    // Auto-set service_due if a despatched_at is being added and the product has an interval
    if (!serviceDueAt && despatchedAt && e.service_interval_months) {
      serviceDueAt = addMonths(despatchedAt, e.service_interval_months);
    }

    const serialNumber = (b.serial_number || e.serial_number).trim();

    const rows = await sql`
      UPDATE erp_product_serials SET
        serial_number = ${serialNumber},
        status = ${status},
        warehouse_id = ${b.warehouse_id === undefined ? e.warehouse_id : (b.warehouse_id || null)},
        parent_serial_id = ${b.parent_serial_id === undefined ? e.parent_serial_id : (b.parent_serial_id || null)},
        received_at = ${b.received_at === undefined ? e.received_at : (b.received_at || null)},
        despatched_at = ${despatchedAt},
        despatched_to_customer_id = ${b.despatched_to_customer_id === undefined
            ? e.despatched_to_customer_id
            : (b.despatched_to_customer_id || null)},
        service_due_at = ${serviceDueAt},
        service_done_at = ${b.service_done_at === undefined ? e.service_done_at : (b.service_done_at || null)},
        notes = ${b.notes === undefined ? e.notes : (b.notes || null)}
      WHERE id = ${sid}
      RETURNING *
    `;
    return res.status(200).json({ ok: true, serial: rows[0] });
  }

  if (req.method === 'DELETE') {
    const rows = await sql`DELETE FROM erp_product_serials WHERE id = ${sid} RETURNING id`;
    if (rows.length === 0) return res.status(404).json({ error: 'Serial not found' });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
