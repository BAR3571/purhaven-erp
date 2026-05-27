import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';
import { nextDespatchNumber, refreshSoFromDespatches } from '../../lib/despatch.js';
import { getMainWarehouseId } from '../../lib/stock.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const q = (req.query.q || '').trim();
    const status = (req.query.status || '').trim() || null;
    const likeQ = q ? '%' + q + '%' : null;

    const rows = await sql`
      SELECT dn.*,
             so.so_number, so.customer_ref,
             c.name AS customer_name, c.account_code AS customer_code,
             so.ship_to_city AS delivery_town,
             w.code AS warehouse_code,
             picker.name AS picker_name, picker.email AS picker_email,
             (SELECT COUNT(*) FROM erp_despatch_lines WHERE despatch_id = dn.id) AS line_count
      FROM erp_despatches dn
      JOIN erp_sales_orders so ON so.id = dn.so_id
      JOIN erp_customers c ON c.id = so.customer_id
      LEFT JOIN erp_warehouses w ON w.id = dn.warehouse_id
      LEFT JOIN erp_users picker ON picker.id = dn.assigned_picker_id
      WHERE (${likeQ}::text IS NULL
             OR dn.despatch_number ILIKE ${likeQ}
             OR so.so_number ILIKE ${likeQ}
             OR c.name ILIKE ${likeQ}
             OR dn.tracking_number ILIKE ${likeQ})
        AND (${status}::text IS NULL OR dn.status = ${status})
      ORDER BY dn.created_at DESC, dn.id DESC
    `;
    return res.status(200).json({ ok: true, despatches: rows });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const soId = parseInt(b.so_id, 10);
    if (!Number.isFinite(soId)) return res.status(400).json({ error: 'so_id is required' });
    const linesIn = Array.isArray(b.lines) ? b.lines : [];
    if (linesIn.length === 0) return res.status(400).json({ error: 'At least one line is required' });

    const soRows = await sql`SELECT * FROM erp_sales_orders WHERE id = ${soId} LIMIT 1`;
    if (soRows.length === 0) return res.status(404).json({ error: 'Sales order not found' });
    const so = soRows[0];
    if (!['confirmed', 'picking', 'part_despatched'].includes(so.status)) {
      return res.status(409).json({ error: `Cannot create a despatch for a ${so.status} order` });
    }

    let warehouseId = b.warehouse_id ? parseInt(b.warehouse_id, 10) : await getMainWarehouseId();
    if (!warehouseId) return res.status(400).json({ error: 'No warehouse available' });

    // Validate each line against its outstanding qty
    const expanded = [];
    for (const li of linesIn) {
      const soLineId = parseInt(li.so_line_id, 10);
      const qty = parseInt(li.qty_to_despatch, 10);
      if (!Number.isFinite(soLineId) || !Number.isFinite(qty) || qty < 1) {
        return res.status(400).json({ error: 'Each line needs so_line_id and qty_to_despatch >= 1' });
      }
      const solRows = await sql`
        SELECT sol.*, p.requires_serial
        FROM erp_sales_order_lines sol
        LEFT JOIN erp_products p ON p.id = sol.product_id
        WHERE sol.id = ${soLineId} AND sol.so_id = ${soId} LIMIT 1
      `;
      if (solRows.length === 0) return res.status(404).json({ error: `SO line ${soLineId} not found on this order` });
      const sol = solRows[0];
      const outstanding = sol.quantity_ordered - sol.quantity_despatched;
      if (qty > outstanding) {
        return res.status(409).json({ error: `Line ${sol.sku}: cannot despatch ${qty}, only ${outstanding} outstanding` });
      }
      expanded.push({ sol, qty });
    }

    const dnNumber = (b.despatch_number || '').trim() || (await nextDespatchNumber());

    let dnId;
    try {
      const ins = await sql`
        INSERT INTO erp_despatches (
          despatch_number, so_id, warehouse_id, status,
          notes, created_by
        ) VALUES (
          ${dnNumber}, ${soId}, ${warehouseId}, 'pending',
          ${b.notes || null}, ${user.id}
        )
        RETURNING id
      `;
      dnId = ins[0].id;
    } catch (err) {
      if (err.message?.includes('erp_despatches_despatch_number_key')) {
        return res.status(409).json({ error: `Despatch number ${dnNumber} already exists` });
      }
      return res.status(500).json({ error: err.message });
    }

    for (const { sol, qty } of expanded) {
      await sql`
        INSERT INTO erp_despatch_lines (
          despatch_id, so_line_id, product_id, sku, description, qty_to_despatch
        ) VALUES (
          ${dnId}, ${sol.id}, ${sol.product_id}, ${sol.sku}, ${sol.description}, ${qty}
        )
      `;
    }

    await refreshSoFromDespatches(soId);
    return res.status(201).json({ ok: true, despatch_id: dnId, despatch_number: dnNumber });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
