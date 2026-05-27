import { sql } from '../../../../lib/db.js';
import { requireUser } from '../../../../lib/session.js';
import { getDespatchWithRelations } from '../../../../lib/despatch.js';
import { newDoc, writeAddressBlock, writeKv, sendPdf, applyPageFooter, colors } from '../../../../lib/pdf.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const dn = await getDespatchWithRelations(id);
  if (!dn) return res.status(404).json({ error: 'Despatch not found' });

  // Find in-stock candidate serials per product line so the picker has a list to pick from
  const productIds = dn.lines.map(l => l.product_id).filter(Boolean);
  let candidatesByProduct = {};
  if (productIds.length > 0 && dn.warehouse_id) {
    const rows = await sql`
      SELECT product_id, serial_number, allocated_to_so_line_id
      FROM erp_product_serials
      WHERE product_id = ANY(${productIds})
        AND warehouse_id = ${dn.warehouse_id}
        AND status = 'in_stock'
      ORDER BY (allocated_to_so_line_id IS NULL) ASC, serial_number ASC
    `;
    for (const r of rows) (candidatesByProduct[r.product_id] ||= []).push(r);
  }

  const doc = newDoc({ title: `Picking Note · ${dn.despatch_number}` });

  // === Meta block (two columns) ===
  const metaY = doc.y;
  writeKv(doc, 48, metaY, [
    ['Pick list', dn.despatch_number],
    ['Sales order', dn.so_number],
    ['Customer', `${dn.customer_name} (${dn.customer_code})`],
    ['Customer ref', dn.customer_ref],
    ['Warehouse', `${dn.warehouse_code || ''} ${dn.warehouse_name ? '— ' + dn.warehouse_name : ''}`],
    ['Picker', dn.picker_name || dn.picker_email || 'Unassigned'],
    ['Generated', new Date().toLocaleString('en-GB')]
  ]);

  // === Ship-to address (right side) ===
  doc.fillColor(colors.DIM).font('Helvetica').fontSize(9).text('SHIPS TO', 320, metaY);
  writeAddressBlock(doc, 320, metaY + 12, {
    name: dn.ship_to_name,
    line1: dn.ship_to_line1,
    line2: dn.ship_to_line2,
    city: dn.ship_to_city,
    county: dn.ship_to_county,
    postcode: dn.ship_to_postcode,
    country: dn.ship_to_country
  });

  // Advance y past whichever column ended lower
  doc.y = Math.max(doc.y, metaY + 130);
  doc.moveDown(0.5);

  // === Lines table ===
  const tableTop = doc.y + 6;
  const cols = [
    { x: 48,  w: 22,  label: '#',           align: 'left'  },
    { x: 70,  w: 90,  label: 'SKU',         align: 'left'  },
    { x: 160, w: 200, label: 'Description', align: 'left'  },
    { x: 360, w: 35,  label: 'Qty',         align: 'right' },
    { x: 395, w: 153, label: 'Serial pulled (write below)', align: 'left' }
  ];

  doc.fillColor(colors.INK).font('Helvetica-Bold').fontSize(9);
  for (const c of cols) doc.text(c.label, c.x, tableTop, { width: c.w, align: c.align });
  doc.moveTo(48, tableTop + 14).lineTo(548, tableTop + 14).strokeColor(colors.LINE).stroke();

  doc.font('Helvetica').fontSize(9).fillColor(colors.INK);
  let cy = tableTop + 20;

  dn.lines.forEach((l, idx) => {
    const lineNo = String(idx + 1);
    const requiresSerial = !!l.requires_serial;
    const candidates = (candidatesByProduct[l.product_id] || []);
    const allocatedSerials = (l.assigned_serials || []).map(s => s.serial_number);
    const candidateText = requiresSerial
      ? (candidates.length === 0
          ? '⚠ No in-stock serials available'
          : 'Available: ' + candidates.slice(0, 6).map(c =>
              c.serial_number + (allocatedSerials.includes(c.serial_number) || c.allocated_to_so_line_id === l.so_line_id ? ' *' : '')
            ).join(', ') + (candidates.length > 6 ? ` + ${candidates.length - 6} more` : ''))
      : '(not serialised)';

    // Row content
    doc.text(lineNo,     cols[0].x, cy, { width: cols[0].w, align: cols[0].align });
    doc.font('Helvetica-Bold').text(l.sku || '', cols[1].x, cy, { width: cols[1].w, align: cols[1].align });
    doc.font('Helvetica').text(l.description || '', cols[2].x, cy, { width: cols[2].w, align: cols[2].align });
    doc.font('Helvetica-Bold').fontSize(11).text(String(l.qty_to_despatch), cols[3].x, cy, { width: cols[3].w, align: cols[3].align });
    doc.font('Helvetica').fontSize(8).fillColor(colors.SOFT).text(candidateText, cols[4].x, cy, { width: cols[4].w });

    // Move y past the tallest column
    const newY = Math.max(doc.y, cy + 16);

    // Draw serial write-in slots for serialised products (qty boxes)
    if (requiresSerial && l.qty_to_despatch > 0) {
      doc.fillColor(colors.DIM).font('Helvetica').fontSize(7);
      const slotY = newY;
      for (let i = 0; i < l.qty_to_despatch; i++) {
        const sx = cols[4].x;
        const sy = slotY + i * 14;
        doc.rect(sx, sy + 1, cols[4].w, 11).strokeColor(colors.LINE).lineWidth(0.5).stroke();
        doc.text(`${i + 1}.`, sx - 14, sy + 2);
      }
      doc.y = slotY + l.qty_to_despatch * 14 + 4;
    } else {
      doc.y = newY + 4;
    }

    doc.fillColor(colors.INK).font('Helvetica').fontSize(9);
    doc.moveTo(48, doc.y).lineTo(548, doc.y).strokeColor(colors.LINE).lineWidth(0.4).stroke();
    cy = doc.y + 6;
    doc.y = cy;
  });

  // === Footer notes ===
  doc.moveDown(1);
  doc.fillColor(colors.SOFT).font('Helvetica-Oblique').fontSize(8);
  doc.text('* Serial allocated to this order line. Pick allocated units first.', 48, doc.y, { width: 500 });
  doc.moveDown(0.4);
  doc.text('After picking, return to the back office to confirm qty + serials, weight, package dimensions and packaging notes.', 48, doc.y, { width: 500 });

  // === Signature block ===
  doc.moveDown(2);
  const sigY = doc.y;
  doc.fillColor(colors.DIM).font('Helvetica').fontSize(8);
  doc.text('Picked by', 48, sigY);
  doc.moveTo(48, sigY + 28).lineTo(220, sigY + 28).strokeColor(colors.LINE).stroke();
  doc.text('Date / time', 280, sigY);
  doc.moveTo(280, sigY + 28).lineTo(420, sigY + 28).strokeColor(colors.LINE).stroke();
  doc.text('Weight (kg)', 440, sigY);
  doc.moveTo(440, sigY + 28).lineTo(548, sigY + 28).strokeColor(colors.LINE).stroke();

  applyPageFooter(doc, { dnNumber: dn.despatch_number });
  return sendPdf(doc, res, `picking-note-${dn.despatch_number}.pdf`);
}
