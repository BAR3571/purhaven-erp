import { sql } from '../../../../lib/db.js';
import { requireUser } from '../../../../lib/session.js';
import { getDespatchWithRelations } from '../../../../lib/despatch.js';
import { newDoc, drawLogoMark, writeAddressBlock, writeKv, sendPdf, applyPageFooter, colors, company } from '../../../../lib/pdf.js';

function money(pence, currency = 'GBP') {
  if (pence == null) return '—';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(pence / 100);
}

// Per-box (per-parcel) commercial invoice. Generates one A4 page per parcel.
// If no parcels are defined yet, falls back to a single page with all items.

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

  // Enrich lines with price + HS data the same way commercial-invoice.js does
  const enriched = dn.lines.length === 0 ? [] : await sql`
    SELECT dnl.id AS dnl_id, dnl.sku, dnl.description,
           sol.unit_price_pence, sol.discount_percent, sol.vat_rate_percent,
           so.currency AS so_currency,
           p.hs_code, p.country_of_origin, p.weight_g
    FROM erp_despatch_lines dnl
    LEFT JOIN erp_sales_order_lines sol ON sol.id = dnl.so_line_id
    LEFT JOIN erp_sales_orders so ON so.id = sol.so_id
    LEFT JOIN erp_products p ON p.id = dnl.product_id
    WHERE dnl.despatch_id = ${id}
  `;
  const byDnl = Object.fromEntries(enriched.map(r => [r.dnl_id, r]));
  const currency = enriched[0]?.so_currency || 'GBP';

  // Build parcel views. If no parcels, synthesise one carrying everything picked.
  let parcels;
  if (dn.parcels && dn.parcels.length > 0) {
    parcels = dn.parcels.map(p => ({
      ...p,
      items: (p.items || []).map(it => {
        const e = byDnl[it.despatch_line_id] || {};
        const l = dn.lines.find(x => x.id === it.despatch_line_id) || {};
        return { ...it, sku: l.sku, description: l.description, hs_code: e.hs_code, country_of_origin: e.country_of_origin, weight_g: e.weight_g, unit_price_pence: e.unit_price_pence || 0, discount_percent: e.discount_percent || 0, vat_rate_percent: e.vat_rate_percent || 20 };
      })
    }));
  } else {
    parcels = [{
      id: null, parcel_no: 1, label: 'Parcel 1 of 1', pallet_label: null,
      weight_kg: dn.weight_kg, length_cm: null, width_cm: null, height_cm: null,
      items: dn.lines.map(l => {
        const e = byDnl[l.id] || {};
        const qty = l.qty_despatched || l.qty_picked || l.qty_to_despatch || 0;
        return { despatch_line_id: l.id, qty, sku: l.sku, description: l.description, hs_code: e.hs_code, country_of_origin: e.country_of_origin, weight_g: e.weight_g, unit_price_pence: e.unit_price_pence || 0, discount_percent: e.discount_percent || 0, vat_rate_percent: e.vat_rate_percent || 20 };
      }).filter(it => it.qty > 0)
    }];
  }

  const total = parcels.length;
  const doc = newDoc({ title: `Commercial Invoice (per box) · ${dn.despatch_number}` });

  parcels.forEach((parcel, idx) => {
    if (idx > 0) {
      doc.addPage();
      // Redraw header on subsequent pages — newDoc only ran once
      drawHeader(doc, `Commercial Invoice (per box) · ${dn.despatch_number}`);
    }
    renderParcel(doc, dn, parcel, idx + 1, total, currency);
  });

  applyPageFooter(doc, { dnNumber: dn.despatch_number });
  return sendPdf(doc, res, `ci-per-box-${dn.despatch_number}.pdf`);
}

function drawHeader(doc, title) {
  // Lightweight header for subsequent pages — newDoc handles page 1
  drawLogoMark(doc, 48, 44, 32);
  doc.fillColor(colors.INK).font('Helvetica-Bold').fontSize(20).text('PurHaven', 88, 50);
  doc.fillColor(colors.SKY).font('Helvetica-Oblique').fontSize(9).text('Your Happy, Healthy, Home.', 88, 75);
  doc.fillColor(colors.INK).font('Helvetica-Bold').fontSize(16).text(title, 48, 120);
  doc.moveTo(48, 145).lineTo(548, 145).strokeColor(colors.LINE).lineWidth(0.6).stroke();
  doc.y = 158;
}

function renderParcel(doc, dn, parcel, num, total, currency) {
  const metaY = doc.y;
  writeKv(doc, 48, metaY, [
    ['Invoice no.',  `${dn.despatch_number}-${String(parcel.parcel_no).padStart(2, '0')}`],
    ['Box',          `${num} of ${total}`],
    ['Pallet',       parcel.pallet_label || '—'],
    ['Order',        dn.so_number],
    ['Despatch',     dn.despatched_at ? new Date(dn.despatched_at).toLocaleDateString('en-GB') : '—'],
    ['Carrier',      `${dn.carrier || '—'}${dn.tracking_number ? ' · ' + dn.tracking_number : ''}`]
  ]);
  doc.fillColor(colors.DIM).font('Helvetica').fontSize(9).text('SHIP TO', 320, metaY);
  writeAddressBlock(doc, 320, metaY + 12, {
    name: dn.ship_to_name, line1: dn.ship_to_line1, line2: dn.ship_to_line2,
    city: dn.ship_to_city, county: dn.ship_to_county,
    postcode: dn.ship_to_postcode, country: dn.ship_to_country
  });
  doc.y = Math.max(doc.y, metaY + 130);

  // Parcel info
  doc.moveDown(0.5);
  const dims = [parcel.length_cm, parcel.width_cm, parcel.height_cm].filter(Boolean).join('×');
  doc.fillColor(colors.SOFT).font('Helvetica').fontSize(9).text(
    `Weight: ${parcel.weight_kg || '—'} kg · Dims: ${dims || '—'} cm${parcel.notes ? ' · ' + parcel.notes : ''}`,
    48, doc.y, { width: 500 }
  );

  // Lines
  const tableTop = doc.y + 10;
  const C = {
    sku:    { x: 48,  w: 70 },
    desc:   { x: 118, w: 130 },
    hs:     { x: 248, w: 50 },
    origin: { x: 298, w: 28 },
    qty:    { x: 326, w: 22 },
    unit:   { x: 348, w: 56 },
    net:    { x: 404, w: 56 },
    vat:    { x: 460, w: 48 },
    total:  { x: 508, w: 40 }
  };
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
  let subtotal = 0, vat = 0;
  for (const it of (parcel.items || [])) {
    const lineSub = Math.round(it.qty * (it.unit_price_pence || 0) * (1 - Number(it.discount_percent || 0) / 100));
    const lineVat = Math.round(lineSub * (it.vat_rate_percent / 100));
    subtotal += lineSub;
    vat += lineVat;
    doc.font('Helvetica-Bold').text(it.sku || '', C.sku.x, cy, { width: C.sku.w });
    doc.font('Helvetica').text(it.description || '', C.desc.x, cy, { width: C.desc.w });
    doc.text(it.hs_code || '—',           C.hs.x,     cy, { width: C.hs.w });
    doc.text(it.country_of_origin || '—', C.origin.x, cy, { width: C.origin.w });
    doc.text(String(it.qty),              C.qty.x,    cy, { width: C.qty.w,   align: 'right' });
    doc.text(money(it.unit_price_pence, currency), C.unit.x, cy, { width: C.unit.w, align: 'right' });
    doc.text(money(lineSub, currency),    C.net.x,    cy, { width: C.net.w,   align: 'right' });
    doc.text(money(lineVat, currency),    C.vat.x,    cy, { width: C.vat.w,   align: 'right' });
    doc.font('Helvetica-Bold').text(money(lineSub + lineVat, currency), C.total.x, cy, { width: C.total.w, align: 'right' });
    doc.font('Helvetica');
    const newY = Math.max(doc.y, cy + 14);
    doc.moveTo(48, newY + 2).lineTo(548, newY + 2).strokeColor(colors.LINE).lineWidth(0.4).stroke();
    cy = newY + 6;
    doc.y = cy;
  }

  // Per-box totals
  doc.moveDown(0.5);
  const baseY = doc.y;
  const labelX = 380, valX = 470, valW = 78, rowH = 14;
  doc.fillColor(colors.INK).font('Helvetica').fontSize(10);
  doc.text('Box subtotal (ex VAT)', labelX, baseY,         { width: 90, lineBreak: false });
  doc.text(money(subtotal, currency), valX, baseY,         { width: valW, align: 'right', lineBreak: false });
  doc.text('Box VAT',            labelX, baseY + rowH,     { width: 90, lineBreak: false });
  doc.text(money(vat, currency), valX, baseY + rowH,       { width: valW, align: 'right', lineBreak: false });
  doc.moveTo(labelX, baseY + 2 * rowH + 2).lineTo(548, baseY + 2 * rowH + 2).strokeColor(colors.INK).stroke();
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text('Box total',          labelX, baseY + 2 * rowH + 6, { width: 90, lineBreak: false });
  doc.text(money(subtotal + vat, currency), valX, baseY + 2 * rowH + 6, { width: valW, align: 'right', lineBreak: false });
}
