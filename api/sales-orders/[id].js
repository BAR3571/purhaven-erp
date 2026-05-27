import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';
import { getSoWithRelations } from '../../lib/sales-orders.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  if (req.method === 'GET') {
    const so = await getSoWithRelations(id);
    if (!so) return res.status(404).json({ error: 'Sales order not found' });
    return res.status(200).json({ ok: true, sales_order: so });
  }

  if (req.method === 'PUT') {
    const b = req.body || {};
    const existing = await sql`SELECT * FROM erp_sales_orders WHERE id = ${id} LIMIT 1`;
    if (existing.length === 0) return res.status(404).json({ error: 'Sales order not found' });
    const e = existing[0];

    if (['despatched', 'invoiced', 'complete', 'cancelled'].includes(e.status)) {
      return res.status(409).json({ error: `Cannot edit a ${e.status} order` });
    }

    const rows = await sql`
      UPDATE erp_sales_orders SET
        customer_ref = ${b.customer_ref === undefined ? e.customer_ref : (b.customer_ref || null)},
        order_date = ${b.order_date || e.order_date},
        required_date = ${b.required_date === undefined ? e.required_date : (b.required_date || null)},
        ship_to_name = ${b.ship_to_name === undefined ? e.ship_to_name : (b.ship_to_name || null)},
        ship_to_line1 = ${b.ship_to_line1 === undefined ? e.ship_to_line1 : (b.ship_to_line1 || null)},
        ship_to_line2 = ${b.ship_to_line2 === undefined ? e.ship_to_line2 : (b.ship_to_line2 || null)},
        ship_to_city = ${b.ship_to_city === undefined ? e.ship_to_city : (b.ship_to_city || null)},
        ship_to_county = ${b.ship_to_county === undefined ? e.ship_to_county : (b.ship_to_county || null)},
        ship_to_postcode = ${b.ship_to_postcode === undefined ? e.ship_to_postcode : (b.ship_to_postcode || null)},
        ship_to_country = ${b.ship_to_country === undefined ? e.ship_to_country : (b.ship_to_country || 'GB')},
        currency = ${b.currency || e.currency},
        notes = ${b.notes === undefined ? e.notes : (b.notes || null)},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return res.status(200).json({ ok: true, sales_order: rows[0] });
  }

  if (req.method === 'DELETE') {
    const existing = await sql`SELECT status FROM erp_sales_orders WHERE id = ${id} LIMIT 1`;
    if (existing.length === 0) return res.status(404).json({ error: 'Sales order not found' });
    if (existing[0].status !== 'draft') {
      return res.status(409).json({ error: `Only draft orders can be deleted (current status: ${existing[0].status})` });
    }
    await sql`DELETE FROM erp_sales_orders WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
