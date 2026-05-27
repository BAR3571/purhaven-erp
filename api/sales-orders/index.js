import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';
import { nextSoNumber } from '../../lib/sales-orders.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const q = (req.query.q || '').trim();
    const status = (req.query.status || '').trim() || null;
    const likeQ = q ? '%' + q + '%' : null;

    const rows = await sql`
      SELECT so.*,
             c.name AS customer_name,
             c.account_code AS customer_code,
             (SELECT COUNT(*) FROM erp_sales_order_lines WHERE so_id = so.id) AS line_count
      FROM erp_sales_orders so
      JOIN erp_customers c ON c.id = so.customer_id
      WHERE (${likeQ}::text IS NULL
             OR so.so_number ILIKE ${likeQ}
             OR c.name ILIKE ${likeQ}
             OR so.customer_ref ILIKE ${likeQ})
        AND (${status}::text IS NULL OR so.status = ${status})
      ORDER BY so.order_date DESC, so.id DESC
    `;
    return res.status(200).json({ ok: true, sales_orders: rows });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const customerId = parseInt(b.customer_id, 10);
    if (!Number.isFinite(customerId)) return res.status(400).json({ error: 'customer_id is required' });

    // Verify customer exists, pull default ship_to from primary default address
    const custRows = await sql`SELECT * FROM erp_customers WHERE id = ${customerId} LIMIT 1`;
    if (custRows.length === 0) return res.status(404).json({ error: 'Customer not found' });
    const customer = custRows[0];

    const addrRows = await sql`
      SELECT * FROM erp_customer_addresses
      WHERE customer_id = ${customerId} AND is_default = TRUE
      LIMIT 1
    `;
    const defaultAddr = addrRows[0] || null;

    const soNumber = (b.so_number || '').trim() || (await nextSoNumber());

    try {
      const rows = await sql`
        INSERT INTO erp_sales_orders (
          so_number, customer_id, status, customer_ref,
          order_date, required_date,
          ship_to_address_id, ship_to_name, ship_to_line1, ship_to_line2,
          ship_to_city, ship_to_county, ship_to_postcode, ship_to_country,
          currency, notes, source, revolut_order_id, created_by
        ) VALUES (
          ${soNumber}, ${customerId}, 'draft', ${b.customer_ref || null},
          ${b.order_date || null}, ${b.required_date || null},
          ${defaultAddr?.id || null},
          ${b.ship_to_name || customer.name},
          ${defaultAddr?.line1 || null},
          ${defaultAddr?.line2 || null},
          ${defaultAddr?.city || null},
          ${defaultAddr?.county || null},
          ${defaultAddr?.postcode || null},
          ${defaultAddr?.country || 'GB'},
          ${b.currency || customer.currency || 'GBP'},
          ${b.notes || null},
          ${b.source || 'manual'},
          ${b.revolut_order_id || null},
          ${user.id}
        )
        RETURNING *
      `;
      return res.status(201).json({ ok: true, sales_order: rows[0] });
    } catch (err) {
      if (err.message?.includes('erp_sales_orders_so_number_key')) {
        return res.status(409).json({ error: `SO number ${soNumber} already exists` });
      }
      return res.status(500).json({ error: err.message });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
