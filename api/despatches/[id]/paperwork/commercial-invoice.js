import { sql } from '../../../../lib/db.js';
import { requireUser } from '../../../../lib/session.js';
import { getDespatchWithRelations } from '../../../../lib/despatch.js';
import { newDoc, writeAddressBlock, writeKv, sendPdf, applyPageFooter, colors, company } from '../../../../lib/pdf.js';

function money(pence, currency = 'GBP') {
  if (pence == null) return '—';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(pence / 100);
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

  const dn = await getDespatchWithRelations(id);
  if (!dn) return res.status(404).json({ error: 'Despatch not found' });

  // Pull pricing + HS/origin data for each despatch line by joining via so_line + product
  const lineIds = dn.lines.map(l => l.id);
  const enriched = lineIds.length === 0 ? [] : await sql`
    SELECT dnl.id AS dnl_id,
           dnl.sku, dnl.description, dnl.qty_despatched, dnl.qty_picked, dnl.qty_to_despatch,
           sol.unit_price_pence, sol.discount_percent, sol.vat_rate_percent, sol.currency,
           p.hs_code, p.country_of_origin, p.weight_g
    FROM erp_despatch_lines dnl
    LEFT JOIN erp_sales_order_lines sol ON sol.id = dnl.so_line_id
    LEFT JOIN erp_products p ON p.id = dnl.product_id
    WHERE dnl.despatch_id = ${id}
    ORDER BY dnl.id ASC
  `;

  const currency = enriched[0]?.currency || 'GBP';
  let subtotal = 0;
  let vat = 0;
  let totalWeightG = 0;
  const rows = enriched.map(r => {
    const qty = r.qty_despatched || r.qty_picked || r.qty_to_despatch || 0;
    const unit = r.unit_price_pence || 0;
    const disc = Number(r.discount_percent || 0);
    const lineSub = Math.round(qty * unit * (1 - disc / 100));
    const lineVat = Math.round(lineSub * ((r.vat_rate_percent || 0) / 100));
    subtotal += lineSub;
    vat += lineVat;
    totalWeightG += qty * (r.weight_g || 0);
    return { ...r, qty, unit, lineSub, lineVat };
  });
  const total = subtotal + vat;

  const doc = newDoc({ title: `Commercial Invoice · ${dn.despatch_number}` });

  // Header meta
  const metaY = doc.y;
  writeKv(doc, 48, metaY, [
    ['Invoice no.',  dn.despatch_number],
    ['Order',        dn.so_number],
    ['Your ref',     dn.customer_ref],
    ['Despatch date', dn.despatched_at ? new Date(dn.despatched_at).toLocaleDateString('en-GB') : '—'],
    ['Carrier',      `${dn.carrier || '—'}${dn.tracking_number ? ' · ' + dn.tracking_number : ''}`],
    ['Incoterms',    'DAP'],
    ['Currency',     currency]
  ]);

  doc.fillColor(colors.DIM).font('Helvetica').fontSize(9).text('SHIP TO', 320, metaY);
  writeAddressBlock(doc, 320, metaY + 12, {
    name: dn.ship_to_name, line1: dn.ship_to_line1, line2: dn.ship_to_line2,
    city: dn.ship_to_city, county: dn.ship_to_county,
    postcode: dn.ship_to_postcode, country: dn.ship_to_country
  });
  doc.y = Math.max(doc.y, metaY + 140);
  doc.moveDown(0.5);

  // From block
  doc.fillColor(colors.DIM).font('Helvetica').fontSize(9).text('FROM', 48, doc.y);
  doc.y += 12;
  writeAddressBlock(doc, 48, doc.y, {
    name: company.name, line1: company.line1, line2: company.line2,
    city: null, county: null, postcode: null, country: company.line3
  });
  doc.fillColor(colors.SOFT).font('Helvetica').fontSize(8).text(`${company.phone} · ${company.email}`, 48, doc.y, { width: 240 });
  doc.moveDown(0.8);

  // Lines table
  const tableTop = doc.y + 6;
  doc.fillColor(colors.INK).font('Helvetica-Bold').fontSize(8);
  doc.text('SKU',          48,  tableTop, { width: 80 });
  doc.text('Description',  130, tableTop, { width: 130 });
  doc.text('HS code',      262, tableTop, { width: 55 });
  doc.text('Origin',       317, tableTop, { width: 40 });
  doc.text('Qty',          359, tableTop, { width: 28, align: 'right' });
  doc.text('Unit',         387, tableTop, { width: 50, align: 'right' });
  doc.text('Net',          437, tableTop, { width: 50, align: 'right' });
  doc.text('VAT',          487, tableTop, { width: 30, align: 'right' });
  doc.text('Total',        517, tableTop, { width: 31, align: 'right' });
  doc.moveTo(48, tableTop + 12).lineTo(548, tableTop + 12).strokeColor(colors.LINE).stroke();

  doc.font('Helvetica').fontSize(8).fillColor(colors.INK);
  let cy = tableTop + 18;
  for (const r of rows) {
    doc.font('Helvetica-Bold').text(r.sku || '', 48, cy, { width: 80 });
    doc.font('Helvetica').text(r.description || '', 130, cy, { width: 130 });
    doc.text(r.hs_code || '—', 262, cy, { width: 55 });
    doc.text(r.country_of_origin || '—', 317, cy, { width: 40 });
    doc.text(String(r.qty), 359, cy, { width: 28, align: 'right' });
    doc.text(money(r.unit, currency), 387, cy, { width: 50, align: 'right' });
    doc.text(money(r.lineSub, currency), 437, cy, { width: 50, align: 'right' });
    doc.text(money(r.lineVat, currency), 487, cy, { width: 30, align: 'right' });
    doc.font('Helvetica-Bold').text(money(r.lineSub + r.lineVat, currency), 517, cy, { width: 31, align: 'right' });
    doc.font('Helvetica');
    let newY = Math.max(doc.y, cy + 14);
    doc.moveTo(48, newY + 2).lineTo(548, newY + 2).strokeColor(colors.LINE).lineWidth(0.4).stroke();
    cy = newY + 6;
    doc.y = cy;
  }

  // Totals
  doc.moveDown(0.5);
  const totalsX = 380, totalsW = 168;
  doc.fillColor(colors.INK).font('Helvetica').fontSize(10);
  doc.text('Subtotal (ex VAT)', totalsX, doc.y, { width: totalsW - 80 });
  doc.text(money(subtotal, currency), totalsX + totalsW - 80, doc.y - 12, { width: 80, align: 'right' });
  doc.moveDown(0.2);
  doc.text('VAT', totalsX, doc.y, { width: totalsW - 80 });
  doc.text(money(vat, currency), totalsX + totalsW - 80, doc.y - 12, { width: 80, align: 'right' });
  doc.moveDown(0.2);
  doc.moveTo(totalsX, doc.y).lineTo(totalsX + totalsW, doc.y).strokeColor(colors.INK).stroke();
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text('Total', totalsX, doc.y, { width: totalsW - 80 });
  doc.text(money(total, currency), totalsX + totalsW - 80, doc.y - 13, { width: 80, align: 'right' });

  // Footer info
  doc.moveDown(1);
  doc.fillColor(colors.SOFT).font('Helvetica').fontSize(8).text(
    `Total declared value for customs: ${money(subtotal, currency)} ex VAT, ${money(total, currency)} inc VAT.\n` +
    `Total gross weight: ${(totalWeightG/1000).toFixed(2)} kg.\n` +
    `Country of declaration: United Kingdom · VAT no. (if applicable): to be added.\n` +
    `Reason for export: SALE.`,
    48, doc.y, { width: 500 }
  );

  applyPageFooter(doc, { dnNumber: dn.despatch_number });
  return sendPdf(doc, res, `commercial-invoice-${dn.despatch_number}.pdf`);
}
