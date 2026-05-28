import { sql } from '../../../../lib/db.js';
import { requireUser } from '../../../../lib/session.js';
import { getDespatchWithRelations } from '../../../../lib/despatch.js';
import { newDoc, writeAddressBlock, writeKv, sendPdf, docToBuffer, applyPageFooter, colors, company } from '../../../../lib/pdf.js';

function money(pence, currency = 'GBP') {
  if (pence == null) return '—';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(pence / 100);
}

export async function renderCommercialInvoiceBuffer(despatchId) {
  const dn = await getDespatchWithRelations(despatchId);
  if (!dn) return { buffer: null, dn: null };
  const doc = await buildDoc(dn);
  const buffer = await docToBuffer(doc);
  return { buffer, dn };
}

async function buildDoc(dn) {
  const id = dn.id;

  // Pull pricing + HS/origin data for each despatch line by joining via so_line + product
  const lineIds = dn.lines.map(l => l.id);
  const enriched = lineIds.length === 0 ? [] : await sql`
    SELECT dnl.id AS dnl_id,
           dnl.sku, dnl.description, dnl.qty_despatched, dnl.qty_picked, dnl.qty_to_despatch,
           sol.unit_price_pence, sol.discount_percent, sol.vat_rate_percent,
           so.currency AS so_currency,
           p.hs_code, p.country_of_origin, p.weight_g
    FROM erp_despatch_lines dnl
    LEFT JOIN erp_sales_order_lines sol ON sol.id = dnl.so_line_id
    LEFT JOIN erp_sales_orders so ON so.id = sol.so_id
    LEFT JOIN erp_products p ON p.id = dnl.product_id
    WHERE dnl.despatch_id = ${id}
    ORDER BY dnl.id ASC
  `;

  const currency = enriched[0]?.so_currency || 'GBP';
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

  // Lines table — currency values need ~55pt at 8pt mono-ish width
  const C = {
    sku:    { x: 48,  w: 60 },
    desc:   { x: 108, w: 116 },
    hs:     { x: 224, w: 50 },
    origin: { x: 274, w: 28 },
    qty:    { x: 302, w: 22 },
    unit:   { x: 324, w: 56 },
    net:    { x: 380, w: 56 },
    vat:    { x: 436, w: 52 },
    total:  { x: 488, w: 60 }
  };

  const tableTop = doc.y + 6;
  doc.fillColor(colors.INK).font('Helvetica-Bold').fontSize(8);
  doc.text('SKU',         C.sku.x,    tableTop, { width: C.sku.w });
  doc.text('Description', C.desc.x,   tableTop, { width: C.desc.w });
  doc.text('HS code',     C.hs.x,     tableTop, { width: C.hs.w });
  doc.text('Origin',      C.origin.x, tableTop, { width: C.origin.w });
  doc.text('Qty',         C.qty.x,    tableTop, { width: C.qty.w,   align: 'right' });
  doc.text('Unit',        C.unit.x,   tableTop, { width: C.unit.w,  align: 'right' });
  doc.text('Net',         C.net.x,    tableTop, { width: C.net.w,   align: 'right' });
  doc.text('VAT',         C.vat.x,    tableTop, { width: C.vat.w,   align: 'right' });
  doc.text('Total',       C.total.x,  tableTop, { width: C.total.w, align: 'right' });
  doc.moveTo(48, tableTop + 12).lineTo(548, tableTop + 12).strokeColor(colors.LINE).stroke();

  doc.font('Helvetica').fontSize(8).fillColor(colors.INK);
  let cy = tableTop + 18;
  for (const r of rows) {
    doc.font('Helvetica-Bold').text(r.sku || '', C.sku.x, cy, { width: C.sku.w });
    doc.font('Helvetica').text(r.description || '', C.desc.x, cy, { width: C.desc.w });
    doc.text(r.hs_code || '—',                C.hs.x,     cy, { width: C.hs.w });
    doc.text(r.country_of_origin || '—',      C.origin.x, cy, { width: C.origin.w });
    doc.text(String(r.qty),                   C.qty.x,    cy, { width: C.qty.w,   align: 'right' });
    doc.text(money(r.unit, currency),         C.unit.x,   cy, { width: C.unit.w,  align: 'right' });
    doc.text(money(r.lineSub, currency),      C.net.x,    cy, { width: C.net.w,   align: 'right' });
    doc.text(money(r.lineVat, currency),      C.vat.x,    cy, { width: C.vat.w,   align: 'right' });
    doc.font('Helvetica-Bold').text(money(r.lineSub + r.lineVat, currency), C.total.x, cy, { width: C.total.w, align: 'right' });
    doc.font('Helvetica');
    let newY = Math.max(doc.y, cy + 14);
    doc.moveTo(48, newY + 2).lineTo(548, newY + 2).strokeColor(colors.LINE).lineWidth(0.4).stroke();
    cy = newY + 6;
    doc.y = cy;
  }

  // Totals — fixed grid, no relative y arithmetic
  doc.moveDown(0.5);
  const baseY = doc.y;
  const labelX = 380, valX = 470, valW = 78, rowH = 14;
  doc.fillColor(colors.INK).font('Helvetica').fontSize(10);
  doc.text('Subtotal (ex VAT)', labelX, baseY,           { width: 90, lineBreak: false });
  doc.text(money(subtotal, currency), valX, baseY,       { width: valW, align: 'right', lineBreak: false });
  doc.text('VAT',                labelX, baseY + rowH,   { width: 90, lineBreak: false });
  doc.text(money(vat, currency), valX, baseY + rowH,     { width: valW, align: 'right', lineBreak: false });
  doc.moveTo(labelX, baseY + 2 * rowH + 2).lineTo(548, baseY + 2 * rowH + 2).strokeColor(colors.INK).stroke();
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text('Total',              labelX, baseY + 2 * rowH + 6, { width: 90, lineBreak: false });
  doc.text(money(total, currency), valX, baseY + 2 * rowH + 6, { width: valW, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(10);
  doc.y = baseY + 3 * rowH + 8;

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
  const { buffer, dn } = await renderCommercialInvoiceBuffer(id);
  if (!buffer) return res.status(404).json({ error: 'Despatch not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="commercial-invoice-${dn.despatch_number}.pdf"`);
  return res.send(buffer);
}
