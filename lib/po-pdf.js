import { sql } from './db.js';
import { getPoWithRelations } from './purchase-orders.js';
import { newDoc, writeAddressBlock, writeKv, applyPageFooter, colors, company } from './pdf.js';

/** Renders the Purchase Order PDF directly to a Buffer.
 *  Used by the /paperwork/po endpoint AND the email + archive flows. */
export async function renderPoBuffer(poId) {
  const po = await getPoWithRelations(poId);
  if (!po) return { buffer: null, po: null };

  // Supplier billing/default address for the SUPPLIER block
  const [supplierAddr] = await sql`
    SELECT line1, line2, city, county, postcode, country
    FROM erp_supplier_addresses
    WHERE supplier_id = ${po.supplier_id}
    ORDER BY is_default DESC, id ASC
    LIMIT 1
  `;

  // Primary supplier contact for the salutation
  const [supplierContact] = await sql`
    SELECT name, email
    FROM erp_supplier_contacts
    WHERE supplier_id = ${po.supplier_id}
    ORDER BY is_primary DESC, id ASC
    LIMIT 1
  `;

  const doc = newDoc({ title: `Purchase Order · ${po.po_number}` });

  // === Meta + supplier + deliver-to columns ===
  const metaY = doc.y;
  writeKv(doc, 48, metaY, [
    ['PO No.',       po.po_number],
    ['Order date',   po.order_date ? new Date(po.order_date).toLocaleDateString('en-GB') : '—'],
    ['Expected',     po.expected_date ? new Date(po.expected_date).toLocaleDateString('en-GB') : '—'],
    ['Your ref',     po.supplier_ref || '—'],
    ['Currency',     po.currency || 'GBP']
  ]);
  const leftEndY = doc.y;

  // Supplier block (middle column)
  doc.fillColor(colors.DIM).font('Helvetica').fontSize(9).text('SUPPLIER', 200, metaY);
  writeAddressBlock(doc, 200, metaY + 12, {
    name: po.supplier_name,
    line1: supplierAddr?.line1,
    line2: supplierAddr?.line2,
    city: supplierAddr?.city,
    county: supplierAddr?.county,
    postcode: supplierAddr?.postcode,
    country: supplierAddr?.country
  });

  // Deliver-to block (right column) — company address
  doc.fillColor(colors.DIM).font('Helvetica').fontSize(9).text('DELIVER TO', 380, metaY);
  writeAddressBlock(doc, 380, metaY + 12, {
    name: po.warehouse_name || 'PurHaven — Main Stock',
    line1: company.line1,
    line2: company.line2,
    city: 'High Ongar',
    county: 'Essex',
    postcode: 'CM5 9NL',
    country: 'United Kingdom'
  });

  doc.y = Math.max(leftEndY, metaY + 140);
  doc.moveDown(0.8);

  // Salutation + body
  const firstName = (supplierContact?.name || po.supplier_name || 'Supplier').split(' ')[0];
  doc.fillColor(colors.INK).font('Helvetica').fontSize(10).text(
    `Dear ${firstName},\n\nPlease supply the following against our purchase order ${po.po_number}. Please confirm receipt and expected despatch date to ${company.email}.`,
    48, doc.y, { width: 500 }
  );
  doc.moveDown(0.8);

  // === Lines table ===
  const tableTop = doc.y + 6;
  doc.fillColor(colors.INK).font('Helvetica-Bold').fontSize(9);
  doc.text('SKU',         48,  tableTop, { width: 90 });
  doc.text('Description', 140, tableTop, { width: 240 });
  doc.text('Qty',         382, tableTop, { width: 32, align: 'right' });
  doc.text('Unit cost',   416, tableTop, { width: 60, align: 'right' });
  doc.text('VAT',         478, tableTop, { width: 28, align: 'right' });
  doc.text('Line total',  508, tableTop, { width: 40, align: 'right' });
  doc.moveTo(48, tableTop + 14).lineTo(548, tableTop + 14).strokeColor(colors.LINE).stroke();

  doc.font('Helvetica').fontSize(10).fillColor(colors.INK);
  let cy = tableTop + 20;
  const currency = po.currency || 'GBP';
  const symbol = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : currency === 'USD' ? '$' : (currency + ' ');
  const money = pence => symbol + (pence / 100).toFixed(2);

  for (const l of po.lines) {
    const lineTotal = Math.round(l.quantity_ordered * l.unit_cost_pence);
    doc.font('Helvetica-Bold').text(l.sku || '—',        48,  cy, { width: 90 });
    doc.font('Helvetica').text(l.description || '',       140, cy, { width: 240 });
    doc.font('Helvetica-Bold').text(String(l.quantity_ordered), 382, cy, { width: 32, align: 'right' });
    doc.font('Helvetica').text(money(l.unit_cost_pence),  416, cy, { width: 60, align: 'right' });
    doc.text((l.vat_rate_percent || 0) + '%',             478, cy, { width: 28, align: 'right' });
    doc.font('Helvetica-Bold').text(money(lineTotal),     508, cy, { width: 40, align: 'right' });
    const newY = Math.max(doc.y, cy + 16);
    doc.moveTo(48, newY + 4).lineTo(548, newY + 4).strokeColor(colors.LINE).lineWidth(0.4).stroke();
    cy = newY + 10;
    doc.y = cy;
  }

  // === Totals ===
  doc.moveDown(0.6);
  const rightLabel = (label, value, bold) => {
    const y = doc.y;
    doc.fillColor(colors.DIM).font('Helvetica').fontSize(9).text(label, 380, y, { width: 100, align: 'right' });
    doc.fillColor(colors.INK).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10).text(value, 485, y, { width: 63, align: 'right' });
    doc.y = y + (bold ? 16 : 13);
  };
  rightLabel('Subtotal', money(po.subtotal_pence || 0));
  rightLabel('VAT',      money(po.vat_pence || 0));
  doc.moveTo(380, doc.y).lineTo(548, doc.y).strokeColor(colors.LINE).stroke();
  doc.y += 4;
  rightLabel('Total',    money(po.total_pence || 0), true);

  // === Notes / terms ===
  if (po.notes) {
    doc.moveDown(0.8);
    doc.fillColor(colors.DIM).font('Helvetica').fontSize(9).text('NOTES', 48, doc.y);
    doc.fillColor(colors.INK).font('Helvetica').fontSize(10).text(po.notes, 48, doc.y + 2, { width: 500 });
  }

  doc.moveDown(1.2);
  doc.fillColor(colors.SOFT).font('Helvetica-Oblique').fontSize(8).text(
    `Quote our PO number ${po.po_number} on your invoice and delivery paperwork. Send invoices to ${company.email}.`,
    48, doc.y, { width: 500 }
  );

  doc.moveDown(0.5);
  doc.fillColor(colors.SOFT).font('Helvetica').fontSize(9).text(
    `${company.name} · ${company.line1}, ${company.line2}, ${company.line3.split(',')[0]}\n${company.phone} · ${company.email} · ${company.site}`,
    48, doc.y, { width: 500, align: 'center' }
  );

  applyPageFooter(doc, { dnNumber: po.po_number });

  return await new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), po }));
    doc.on('error', reject);
    doc.end();
  });
}
