import { sql } from '../../../../lib/db.js';
import { requireUser } from '../../../../lib/session.js';
import { getDespatchWithRelations } from '../../../../lib/despatch.js';
import { newDoc, writeAddressBlock, writeKv, sendPdf, applyPageFooter, colors, company } from '../../../../lib/pdf.js';

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

  const doc = newDoc({ title: `Despatch Note · ${dn.despatch_number}` });

  // Meta + ship-to (customer-facing — no internal IDs)
  const metaY = doc.y;
  writeKv(doc, 48, metaY, [
    ['Despatch No.', dn.despatch_number],
    ['Order ref',   dn.so_number],
    ['Your ref',    dn.customer_ref],
    ['Despatched',  dn.despatched_at ? new Date(dn.despatched_at).toLocaleDateString('en-GB') : '—'],
    ['Carrier',     dn.carrier || '—'],
    ['Tracking',    dn.tracking_number || '—'],
    ['Packages',    `${dn.number_of_packages || 1}${dn.weight_kg ? ' · ' + dn.weight_kg + ' kg' : ''}`]
  ]);

  doc.fillColor(colors.DIM).font('Helvetica').fontSize(9).text('DELIVER TO', 320, metaY);
  writeAddressBlock(doc, 320, metaY + 12, {
    name: dn.ship_to_name, line1: dn.ship_to_line1, line2: dn.ship_to_line2,
    city: dn.ship_to_city, county: dn.ship_to_county,
    postcode: dn.ship_to_postcode, country: dn.ship_to_country
  });
  doc.y = Math.max(doc.y, metaY + 140);
  doc.moveDown(0.5);

  // Customer note
  doc.fillColor(colors.INK).font('Helvetica').fontSize(10).text(
    `Dear ${(dn.ship_to_name || dn.customer_name || 'Customer').split(' ')[0]},\n\nThanks for your order with PurHaven. The goods listed below have been despatched. If anything is missing or arrives damaged, please reply to ${company.email} within 7 days.`,
    48, doc.y, { width: 500 }
  );
  doc.moveDown(0.8);

  // Lines table
  const tableTop = doc.y + 6;
  doc.fillColor(colors.INK).font('Helvetica-Bold').fontSize(9);
  doc.text('SKU',         48,  tableTop, { width: 110 });
  doc.text('Description', 160, tableTop, { width: 320 });
  doc.text('Qty',         490, tableTop, { width: 58, align: 'right' });
  doc.moveTo(48, tableTop + 14).lineTo(548, tableTop + 14).strokeColor(colors.LINE).stroke();

  doc.font('Helvetica').fontSize(10).fillColor(colors.INK);
  let cy = tableTop + 20;
  for (const l of dn.lines) {
    doc.font('Helvetica-Bold').text(l.sku || '', 48, cy, { width: 110 });
    doc.font('Helvetica').text(l.description || '', 160, cy, { width: 320 });
    doc.font('Helvetica-Bold').text(String(l.qty_despatched || l.qty_picked || l.qty_to_despatch), 490, cy, { width: 58, align: 'right' });
    let newY = Math.max(doc.y, cy + 16);
    // List serials below as warranty reference for the customer
    if ((l.assigned_serials || []).length > 0) {
      doc.fillColor(colors.DIM).font('Helvetica').fontSize(8);
      const serials = l.assigned_serials.map(s => s.serial_number).join(' · ');
      doc.text('Serial no(s): ' + serials, 160, newY, { width: 380 });
      newY = Math.max(doc.y, newY + 11);
      doc.fillColor(colors.INK).font('Helvetica').fontSize(10);
    }
    doc.moveTo(48, newY + 4).lineTo(548, newY + 4).strokeColor(colors.LINE).lineWidth(0.4).stroke();
    cy = newY + 10;
    doc.y = cy;
  }

  // Service-interval reminder if any line has one
  const hasServicedItems = dn.lines.some(l => l.service_interval_months);
  if (hasServicedItems) {
    doc.moveDown(0.8);
    doc.fillColor(colors.SOFT).font('Helvetica-Oblique').fontSize(9).text(
      'Service reminder: filters and UV lamps typically need replacing annually. We will email you when each unit is due — based on the despatch date above plus the manufacturer\'s recommended interval.',
      48, doc.y, { width: 500 }
    );
  }

  doc.moveDown(1.2);
  doc.fillColor(colors.SOFT).font('Helvetica').fontSize(9).text(
    `Thank you for choosing PurHaven.\n${company.name} · ${company.line1}, ${company.line2}, ${company.line3.split(',')[0]}\n${company.phone} · ${company.email} · ${company.site}`,
    48, doc.y, { width: 500, align: 'center' }
  );

  applyPageFooter(doc, { dnNumber: dn.despatch_number });
  return sendPdf(doc, res, `despatch-note-${dn.despatch_number}.pdf`);
}
