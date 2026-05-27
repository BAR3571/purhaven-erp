import { sql } from '../../../lib/db.js';
import { requireUser } from '../../../lib/session.js';
import { refreshSoFromDespatches, addMonths } from '../../../lib/despatch.js';
import { adjustStock } from '../../../lib/stock.js';

// Status transitions on a despatch.
const ALLOWED_FROM = {
  'start-picking':   ['pending'],
  'confirm-picking': ['picking'],
  'unpack':          ['packed'],         // back to picking, for corrections
  'despatch':        ['packed'],
  'cancel':          ['pending', 'picking', 'packed']
};

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const action = (req.body?.action || '').trim();
  if (!ALLOWED_FROM[action]) return res.status(400).json({ error: 'Unknown action' });

  const rows = await sql`
    SELECT dn.*, so.customer_id, so.id AS so_id
    FROM erp_despatches dn
    JOIN erp_sales_orders so ON so.id = dn.so_id
    WHERE dn.id = ${id} LIMIT 1
  `;
  if (rows.length === 0) return res.status(404).json({ error: 'Despatch not found' });
  const dn = rows[0];
  if (!ALLOWED_FROM[action].includes(dn.status)) {
    return res.status(409).json({ error: `Cannot ${action} a ${dn.status} despatch` });
  }

  if (action === 'start-picking') {
    const pickerId = req.body?.assigned_picker_id ? parseInt(req.body.assigned_picker_id, 10) : user.id;
    await sql`UPDATE erp_despatches SET status = 'picking', assigned_picker_id = ${pickerId} WHERE id = ${id}`;
    await refreshSoFromDespatches(dn.so_id);
  }

  else if (action === 'confirm-picking') {
    // Body: { lines: [{ despatch_line_id, qty_picked, serials: [] }] }
    const linesIn = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (linesIn.length === 0) return res.status(400).json({ error: 'lines is required' });

    const dnLines = await sql`
      SELECT dnl.*, p.requires_serial
      FROM erp_despatch_lines dnl
      LEFT JOIN erp_products p ON p.id = dnl.product_id
      WHERE dnl.despatch_id = ${id}
    `;
    const linesById = Object.fromEntries(dnLines.map(l => [l.id, l]));

    for (const li of linesIn) {
      const dnlId = parseInt(li.despatch_line_id, 10);
      const qtyPicked = parseInt(li.qty_picked, 10);
      const line = linesById[dnlId];
      if (!line) return res.status(404).json({ error: `Despatch line ${dnlId} not on this despatch` });
      if (!Number.isFinite(qtyPicked) || qtyPicked < 0 || qtyPicked > line.qty_to_despatch) {
        return res.status(400).json({ error: `Line ${line.sku}: qty_picked must be 0..${line.qty_to_despatch}` });
      }
      const serials = Array.isArray(li.serials)
        ? li.serials.map(s => (s || '').trim()).filter(Boolean)
        : [];
      if (line.requires_serial && serials.length !== qtyPicked) {
        return res.status(400).json({ error: `Line ${line.sku} requires a serial per unit (picked ${qtyPicked}, got ${serials.length} serials)` });
      }

      // Update qty_picked
      await sql`UPDATE erp_despatch_lines SET qty_picked = ${qtyPicked} WHERE id = ${dnlId}`;

      // Re-link serials: clear existing then attach the listed ones
      await sql`UPDATE erp_product_serials SET despatch_line_id = NULL, despatch_id = NULL WHERE despatch_line_id = ${dnlId}`;
      for (const sn of serials) {
        const snRows = await sql`
          SELECT id, status, allocated_to_so_line_id, despatch_id
          FROM erp_product_serials
          WHERE product_id = ${line.product_id} AND serial_number = ${sn} LIMIT 1
        `;
        if (snRows.length === 0) {
          return res.status(404).json({ error: `Serial ${sn} not found for product` });
        }
        const s = snRows[0];
        if (s.status !== 'in_stock') {
          return res.status(409).json({ error: `Serial ${sn} has status ${s.status} — cannot pick` });
        }
        if (s.allocated_to_so_line_id && s.allocated_to_so_line_id !== line.so_line_id) {
          return res.status(409).json({ error: `Serial ${sn} is allocated to a different SO line` });
        }
        await sql`UPDATE erp_product_serials SET despatch_id = ${id}, despatch_line_id = ${dnlId} WHERE id = ${s.id}`;
      }
    }

    await sql`UPDATE erp_despatches SET status = 'packed', picked_at = NOW(), packed_at = NOW() WHERE id = ${id}`;
  }

  else if (action === 'unpack') {
    await sql`UPDATE erp_despatches SET status = 'picking', packed_at = NULL WHERE id = ${id}`;
  }

  else if (action === 'despatch') {
    // Final shipment. Decrement stock, flip serials to 'despatched' + set service_due,
    // set qty_despatched on lines, refresh SO status.
    const b = req.body || {};

    // Pull lines + serials
    const dnLines = await sql`
      SELECT dnl.*, p.requires_serial, p.service_interval_months
      FROM erp_despatch_lines dnl
      LEFT JOIN erp_products p ON p.id = dnl.product_id
      WHERE dnl.despatch_id = ${id}
    `;
    if (dnLines.length === 0) return res.status(400).json({ error: 'No lines on this despatch' });

    // Sanity: every line has qty_picked == qty_to_despatch
    for (const l of dnLines) {
      if (l.qty_picked !== l.qty_to_despatch) {
        return res.status(409).json({ error: `Line ${l.sku} has qty_picked ${l.qty_picked} ≠ qty_to_despatch ${l.qty_to_despatch}` });
      }
    }

    const despatchedAt = new Date().toISOString();
    for (const l of dnLines) {
      // Mark line despatched
      await sql`UPDATE erp_despatch_lines SET qty_despatched = qty_picked WHERE id = ${l.id}`;

      // Decrement stock at the warehouse
      if (l.product_id) {
        await adjustStock({
          productId: l.product_id,
          warehouseId: dn.warehouse_id,
          delta: -l.qty_picked,
          movementType: 'despatch',
          referenceType: 'despatch',
          referenceId: id,
          notes: `${dn.despatch_number} / SO line ${l.so_line_id || ''}`,
          userId: user.id
        });
      }

      // Flip linked serials to 'despatched' + set service_due
      const serials = await sql`SELECT * FROM erp_product_serials WHERE despatch_line_id = ${l.id}`;
      for (const s of serials) {
        let serviceDue = s.service_due_at;
        if (!serviceDue && l.service_interval_months) {
          serviceDue = addMonths(despatchedAt, l.service_interval_months);
        }
        await sql`
          UPDATE erp_product_serials SET
            status = 'despatched',
            despatched_at = ${despatchedAt},
            despatched_to_customer_id = ${dn.customer_id},
            service_due_at = ${serviceDue},
            allocated_to_so_line_id = NULL
          WHERE id = ${s.id}
        `;
      }

      // Release any PO-line allocations on this SO line (now fulfilled)
      if (l.so_line_id) {
        await sql`DELETE FROM erp_so_po_allocations WHERE so_line_id = ${l.so_line_id}`;
      }
    }

    await sql`
      UPDATE erp_despatches SET
        status = 'despatched',
        despatched_at = ${despatchedAt},
        carrier = ${b.carrier || dn.carrier},
        tracking_number = ${b.tracking_number || dn.tracking_number},
        weight_kg = ${b.weight_kg ?? dn.weight_kg},
        number_of_packages = ${b.number_of_packages ?? dn.number_of_packages}
      WHERE id = ${id}
    `;
    await refreshSoFromDespatches(dn.so_id);
  }

  else if (action === 'cancel') {
    // Release any serial assignments
    await sql`UPDATE erp_product_serials SET despatch_id = NULL, despatch_line_id = NULL WHERE despatch_id = ${id} AND status = 'in_stock'`;
    await sql`UPDATE erp_despatches SET status = 'cancelled', cancelled_at = NOW() WHERE id = ${id}`;
    await refreshSoFromDespatches(dn.so_id);
  }

  const updated = await sql`SELECT status FROM erp_despatches WHERE id = ${id}`;
  return res.status(200).json({ ok: true, status: updated[0].status });
}
