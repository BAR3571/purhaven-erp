import { requireUser } from '../../../../lib/session.js';
import { getDespatchWithRelations } from '../../../../lib/despatch.js';
import { newDoc, drawLogoMark, writeAddressBlock, sendPdf, docToBuffer, applyPageFooter, colors, company } from '../../../../lib/pdf.js';

// One A6-ish label per parcel (4 per A4 page, 2x2 grid).
// If no parcels defined, generates one label for the whole despatch.

export async function renderParcelLabelsBuffer(despatchId) {
  const dn = await getDespatchWithRelations(despatchId);
  if (!dn) return { buffer: null, dn: null };
  const doc = await buildDoc(dn);
  const buffer = await docToBuffer(doc);
  return { buffer, dn };
}

async function buildDoc(dn) {

  const parcels = (dn.parcels && dn.parcels.length > 0) ? dn.parcels : [
    { parcel_no: 1, label: 'Parcel 1 of 1', pallet_label: null, weight_kg: dn.weight_kg }
  ];
  const total = parcels.length;

  const doc = newDoc({ title: `Parcel Labels · ${dn.despatch_number}` });
  doc.y = 158;

  // A4 = 595 × 842 pt. 2×2 grid with 24pt outer margin = each label ~273 × 397 pt.
  const cellW = 273;
  const cellH = 397;
  const startX = 24, startY = 24;

  parcels.forEach((parcel, idx) => {
    const pos = idx % 4;
    if (idx > 0 && pos === 0) doc.addPage();
    const col = pos % 2;
    const row = Math.floor(pos / 2);
    const x = startX + col * (cellW + 1);
    const y = startY + row * (cellH + 1);
    renderLabel(doc, dn, parcel, idx + 1, total, x, y, cellW, cellH);
  });

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
  const { buffer, dn } = await renderParcelLabelsBuffer(id);
  if (!buffer) return res.status(404).json({ error: 'Despatch not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="parcel-labels-${dn.despatch_number}.pdf"`);
  return res.send(buffer);
}

function renderLabel(doc, dn, parcel, num, total, x, y, w, h) {
  // Outer border (dashed) so labels can be cut out
  doc.rect(x, y, w, h).dash(3, { space: 2 }).strokeColor(colors.DIM).lineWidth(0.4).stroke().undash();

  // === Top band: PurHaven mark + "FROM"
  drawLogoMark(doc, x + 12, y + 14, 24);
  doc.fillColor(colors.INK).font('Helvetica-Bold').fontSize(14).text('PurHaven', x + 42, y + 18);
  doc.fillColor(colors.DIM).font('Helvetica').fontSize(7).text('FROM', x + 12, y + 50);
  doc.fillColor(colors.SOFT).font('Helvetica').fontSize(8).text(
    `${company.name}\n${company.line1}, ${company.line2}\n${company.line3}\n${company.phone}`,
    x + 12, y + 60, { width: w - 24 }
  );

  // === Big TO block
  const toY = y + 130;
  doc.fillColor(colors.DIM).font('Helvetica-Bold').fontSize(8).text('SHIP TO', x + 12, toY);
  doc.fillColor(colors.INK).font('Helvetica-Bold').fontSize(14);
  doc.text(dn.ship_to_name || dn.customer_name || '—', x + 12, toY + 14, { width: w - 24 });
  let addrY = doc.y + 2;
  doc.font('Helvetica').fontSize(11).fillColor(colors.INK);
  for (const line of [dn.ship_to_line1, dn.ship_to_line2, dn.ship_to_city, dn.ship_to_county]) {
    if (!line) continue;
    doc.text(line, x + 12, addrY, { width: w - 24 });
    addrY = doc.y;
  }
  doc.font('Helvetica-Bold').fontSize(14).text(dn.ship_to_postcode || '', x + 12, addrY + 2, { width: w - 24 });
  doc.font('Helvetica').fontSize(10).fillColor(colors.SOFT).text(dn.ship_to_country || 'GB', x + 12, doc.y + 2, { width: w - 24 });

  // === Bottom band: carrier + parcel number + tracking
  const bottomY = y + h - 80;
  doc.moveTo(x + 12, bottomY).lineTo(x + w - 12, bottomY).strokeColor(colors.LINE).lineWidth(0.6).stroke();

  doc.fillColor(colors.INK).font('Helvetica-Bold').fontSize(22)
     .text(`${num} / ${total}`, x + 12, bottomY + 8, { width: 100 });
  doc.fillColor(colors.DIM).font('Helvetica').fontSize(7).text('PARCEL', x + 12, bottomY + 34);

  doc.fillColor(colors.INK).font('Helvetica-Bold').fontSize(11)
     .text(dn.carrier || '—', x + 120, bottomY + 12, { width: w - 132 });
  doc.fillColor(colors.SOFT).font('Helvetica').fontSize(8)
     .text(`Tracking: ${dn.tracking_number || '—'}`, x + 120, bottomY + 26, { width: w - 132 });

  const dims = [parcel.length_cm, parcel.width_cm, parcel.height_cm].filter(Boolean).join('×');
  doc.fillColor(colors.DIM).font('Helvetica').fontSize(7).text(
    `${dn.despatch_number} · ${dn.so_number}${parcel.pallet_label ? ' · ' + parcel.pallet_label : ''}` +
    `\nWeight: ${parcel.weight_kg || dn.weight_kg || '—'} kg${dims ? '  ·  ' + dims + ' cm' : ''}`,
    x + 12, bottomY + 46, { width: w - 24 }
  );
}
