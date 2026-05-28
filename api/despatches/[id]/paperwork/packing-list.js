import { sql } from '../../../../lib/db.js';
import { requireUser } from '../../../../lib/session.js';
import { getDespatchWithRelations } from '../../../../lib/despatch.js';
import { newDoc, writeAddressBlock, writeKv, sendPdf, docToBuffer, applyPageFooter, colors } from '../../../../lib/pdf.js';

export async function renderPackingListBuffer(despatchId) {
  const dn = await getDespatchWithRelations(despatchId);
  if (!dn) return { buffer: null, dn: null };
  const doc = await buildDoc(dn);
  const buffer = await docToBuffer(doc);
  return { buffer, dn };
}

async function buildDoc(dn) {
  const doc = newDoc({ title: `Packing List · ${dn.despatch_number}` });

  // Meta + ship-to
  const metaY = doc.y;
  writeKv(doc, 48, metaY, [
    ['Despatch', dn.despatch_number],
    ['Sales order', dn.so_number],
    ['Customer', `${dn.customer_name} (${dn.customer_code})`],
    ['Customer ref', dn.customer_ref],
    ['Despatched', dn.despatched_at ? new Date(dn.despatched_at).toLocaleDateString('en-GB') : '—'],
    ['Carrier', `${dn.carrier || '—'}${dn.tracking_number ? ' · ' + dn.tracking_number : ''}`],
    ['Packages', `${dn.number_of_packages || 1}${dn.weight_kg ? ' · ' + dn.weight_kg + ' kg' : ''}${dn.package_dims_cm ? ' · ' + dn.package_dims_cm : ''}`]
  ]);

  doc.fillColor(colors.DIM).font('Helvetica').fontSize(9).text('SHIP TO', 320, metaY);
  writeAddressBlock(doc, 320, metaY + 12, {
    name: dn.ship_to_name, line1: dn.ship_to_line1, line2: dn.ship_to_line2,
    city: dn.ship_to_city, county: dn.ship_to_county,
    postcode: dn.ship_to_postcode, country: dn.ship_to_country
  });
  doc.y = Math.max(doc.y, metaY + 140);
  doc.moveDown(0.5);

  // Table
  const tableTop = doc.y + 6;
  doc.fillColor(colors.INK).font('Helvetica-Bold').fontSize(9);
  doc.text('SKU',         48,  tableTop, { width: 110 });
  doc.text('Description', 160, tableTop, { width: 280 });
  doc.text('Qty',         440, tableTop, { width: 60, align: 'right' });
  doc.text('Serials',     510, tableTop, { width: 40, align: 'right' });
  doc.moveTo(48, tableTop + 14).lineTo(548, tableTop + 14).strokeColor(colors.LINE).stroke();

  doc.font('Helvetica').fontSize(9).fillColor(colors.INK);
  let cy = tableTop + 20;
  for (const l of dn.lines) {
    doc.font('Helvetica-Bold').text(l.sku || '', 48, cy, { width: 110 });
    doc.font('Helvetica').text(l.description || '', 160, cy, { width: 280 });
    doc.font('Helvetica-Bold').text(String(l.qty_despatched || l.qty_picked || l.qty_to_despatch), 440, cy, { width: 60, align: 'right' });
    doc.font('Helvetica').text(String((l.assigned_serials || []).length || '—'), 510, cy, { width: 40, align: 'right' });
    let newY = Math.max(doc.y, cy + 14);
    // Serial chip list, indented
    if ((l.assigned_serials || []).length > 0) {
      doc.fillColor(colors.SOFT).font('Helvetica').fontSize(8);
      const serialList = l.assigned_serials.map(s => s.serial_number).join(' · ');
      doc.text(serialList, 160, newY, { width: 280 });
      newY = Math.max(doc.y, newY + 12);
      doc.fillColor(colors.INK).font('Helvetica').fontSize(9);
    }
    doc.moveTo(48, newY + 4).lineTo(548, newY + 4).strokeColor(colors.LINE).lineWidth(0.4).stroke();
    cy = newY + 10;
    doc.y = cy;
  }

  // Totals strip
  const totalQty = dn.lines.reduce((s, l) => s + (l.qty_despatched || l.qty_picked || l.qty_to_despatch || 0), 0);
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(colors.INK);
  doc.text(`Total units: ${totalQty}    ·    Packages: ${dn.number_of_packages || 1}    ·    Total weight: ${dn.weight_kg || '—'} kg`, 48, doc.y, { width: 500 });
  if (dn.packaging_notes) {
    doc.moveDown(0.5);
    doc.fillColor(colors.SOFT).font('Helvetica-Oblique').fontSize(9).text('Packaging notes: ' + dn.packaging_notes, 48, doc.y, { width: 500 });
  }

  applyPageFooter(doc, { dnNumber: dn.despatch_number });
  return doc;
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const { buffer, dn } = await renderPackingListBuffer(id);
  if (!buffer) return res.status(404).json({ error: 'Despatch not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="packing-list-${dn.despatch_number}.pdf"`);
  return res.send(buffer);
}
