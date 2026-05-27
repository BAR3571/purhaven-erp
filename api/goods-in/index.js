import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';
import { nextGiNumber, refreshPoFromReceipts } from '../../lib/goods-in.js';
import { adjustStock, getMainWarehouseId } from '../../lib/stock.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const q = (req.query.q || '').trim();
    const likeQ = q ? '%' + q + '%' : null;

    const rows = await sql`
      SELECT gi.*,
             po.po_number,
             s.name AS supplier_name,
             w.code AS warehouse_code,
             u.email AS received_by_email,
             u.name AS received_by_name,
             (SELECT COUNT(*) FROM erp_goods_in_lines WHERE gi_id = gi.id) AS line_count
      FROM erp_goods_in gi
      LEFT JOIN erp_purchase_orders po ON po.id = gi.po_id
      LEFT JOIN erp_suppliers s ON s.id = po.supplier_id
      JOIN erp_warehouses w ON w.id = gi.warehouse_id
      LEFT JOIN erp_users u ON u.id = gi.received_by
      WHERE (${likeQ}::text IS NULL
             OR gi.gi_number ILIKE ${likeQ}
             OR po.po_number ILIKE ${likeQ}
             OR s.name ILIKE ${likeQ}
             OR gi.tracking_number ILIKE ${likeQ})
      ORDER BY gi.received_at DESC, gi.id DESC
    `;
    return res.status(200).json({ ok: true, goods_in: rows });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const poId = b.po_id ? parseInt(b.po_id, 10) : null;
    let warehouseId = b.warehouse_id ? parseInt(b.warehouse_id, 10) : null;
    const lines = Array.isArray(b.lines) ? b.lines : [];
    if (lines.length === 0) return res.status(400).json({ error: 'At least one line is required' });

    let po = null;
    if (poId) {
      const poRows = await sql`SELECT * FROM erp_purchase_orders WHERE id = ${poId} LIMIT 1`;
      if (poRows.length === 0) return res.status(404).json({ error: 'Purchase order not found' });
      po = poRows[0];
      if (['received', 'closed', 'cancelled'].includes(po.status)) {
        return res.status(409).json({ error: `Cannot receive against a ${po.status} order` });
      }
      if (!warehouseId) warehouseId = po.deliver_to_warehouse_id;
    }
    if (!warehouseId) warehouseId = await getMainWarehouseId();
    if (!warehouseId) return res.status(400).json({ error: 'No warehouse available' });

    // Validate lines + pull line metadata
    const expanded = [];
    for (const line of lines) {
      const qty = parseInt(line.qty_received, 10);
      if (!Number.isFinite(qty) || qty < 1) {
        return res.status(400).json({ error: 'Each line needs qty_received >= 1' });
      }
      const condition = ['good', 'damaged', 'quarantine'].includes(line.condition) ? line.condition : 'good';
      let poLineId = line.po_line_id ? parseInt(line.po_line_id, 10) : null;
      let productId = line.product_id ? parseInt(line.product_id, 10) : null;
      let sku = line.sku || null;
      let description = line.description || null;
      let qtyExpected = null;
      let requiresSerial = false;

      if (poLineId) {
        const polRows = await sql`
          SELECT pol.*, p.requires_serial
          FROM erp_purchase_order_lines pol
          LEFT JOIN erp_products p ON p.id = pol.product_id
          WHERE pol.id = ${poLineId} AND pol.po_id = ${poId}
          LIMIT 1
        `;
        if (polRows.length === 0) return res.status(404).json({ error: `PO line ${poLineId} not found` });
        const pol = polRows[0];
        productId = productId || pol.product_id;
        sku = sku || pol.sku;
        description = description || pol.description;
        qtyExpected = pol.quantity_ordered - pol.quantity_received;
        requiresSerial = !!pol.requires_serial;
        // Don't enforce qty <= expected (allow over-receipt; flag as discrepancy below)
      } else if (productId) {
        const prodRows = await sql`SELECT sku, name, requires_serial FROM erp_products WHERE id = ${productId} LIMIT 1`;
        if (prodRows.length === 0) return res.status(404).json({ error: `Product ${productId} not found` });
        sku = sku || prodRows[0].sku;
        description = description || prodRows[0].name;
        requiresSerial = !!prodRows[0].requires_serial;
      }

      const serials = Array.isArray(line.serials) ? line.serials.map(s => (s || '').trim()).filter(Boolean) : [];
      if (requiresSerial && serials.length !== qty) {
        return res.status(400).json({ error: `${sku || 'This product'} requires a serial per unit (qty ${qty}, got ${serials.length} serials)` });
      }

      expanded.push({ poLineId, productId, sku, description, qty, condition, qtyExpected, requiresSerial, serials, notes: line.notes || null });
    }

    // All validated — start writing
    const giNumber = (b.gi_number || '').trim() || (await nextGiNumber());
    const anyDiscrepancy = expanded.some(l => l.qtyExpected != null && (l.qty > l.qtyExpected || l.condition !== 'good'));
    const status = anyDiscrepancy ? 'discrepancy' : 'received';

    let giId;
    try {
      const giRows = await sql`
        INSERT INTO erp_goods_in (
          gi_number, po_id, warehouse_id, status,
          received_at, received_by,
          carrier, tracking_number, notes
        ) VALUES (
          ${giNumber}, ${poId}, ${warehouseId}, ${status},
          COALESCE(${b.received_at || null}::timestamptz, NOW()),
          ${user.id},
          ${b.carrier || null}, ${b.tracking_number || null}, ${b.notes || null}
        )
        RETURNING id
      `;
      giId = giRows[0].id;
    } catch (err) {
      if (err.message?.includes('erp_goods_in_gi_number_key')) {
        return res.status(409).json({ error: `GI number ${giNumber} already exists` });
      }
      return res.status(500).json({ error: err.message });
    }

    // Insert each line + serials + stock adjustment
    for (const l of expanded) {
      const gilRows = await sql`
        INSERT INTO erp_goods_in_lines (
          gi_id, po_line_id, product_id, sku, description,
          qty_expected, qty_received, condition, notes
        ) VALUES (
          ${giId}, ${l.poLineId}, ${l.productId}, ${l.sku}, ${l.description},
          ${l.qtyExpected}, ${l.qty}, ${l.condition}, ${l.notes}
        )
        RETURNING id
      `;
      const gilId = gilRows[0].id;

      // Mint serials if any
      for (const sn of l.serials) {
        try {
          await sql`
            INSERT INTO erp_product_serials (
              product_id, serial_number, status, warehouse_id, received_at, goods_in_line_id
            ) VALUES (
              ${l.productId}, ${sn}, 'in_stock', ${warehouseId}, NOW(), ${gilId}
            )
          `;
        } catch (err) {
          if (err.message?.includes('erp_product_serials_product_id_serial_number_key')) {
            // Continue with the receipt but flag
            await sql`UPDATE erp_goods_in SET status = 'discrepancy' WHERE id = ${giId}`;
          } else {
            throw err;
          }
        }
      }

      // Adjust stock at the warehouse + write a movement
      if (l.productId && l.condition === 'good') {
        await adjustStock({
          productId: l.productId,
          warehouseId,
          delta: l.qty,
          movementType: 'receipt',
          referenceType: 'goods_in',
          referenceId: giId,
          notes: `${giNumber}${l.poLineId ? ' / PO line ' + l.poLineId : ''}`,
          userId: user.id
        });
      }
    }

    // Roll the PO forward
    if (poId) await refreshPoFromReceipts(poId);

    return res.status(201).json({ ok: true, gi_id: giId, gi_number: giNumber, status });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
