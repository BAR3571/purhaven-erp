import PDFDocument from 'pdfkit';

// Brand palette
const INK   = '#0a1f2e';
const SOFT  = '#2a4456';
const DIM   = '#5a7280';
const LINE  = '#c8dde6';
const SKY   = '#2c6e85';

const COMPANY = {
  name:    'UVCVTM Limited trading as PurHaven',
  line1:   'Unit 6 Nash Hall',
  line2:   'The Street, High Ongar',
  line3:   'Essex CM5 9NL, United Kingdom',
  phone:   '0800 138 7043',
  email:   'sales@uvcvtm.com',
  site:    'purhaven.co.uk'
};

/** Standard A4 doc with PurHaven header. Returns a PDFDocument ready to add body content. */
export function newDoc({ title }) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, left: 48, right: 48, bottom: 50 },
    info: {
      Title: title,
      Author: 'PurHaven',
      Producer: 'PurHaven Back Office'
    }
  });

  // === Header band ===
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text('PurHaven', 48, 50);
  doc.fillColor(SKY).font('Helvetica-Oblique').fontSize(9).text('Your Happy, Healthy, Home.', 48, 75);

  // Right-aligned company block
  doc.font('Helvetica').fontSize(8).fillColor(DIM);
  const rightX = 350;
  doc.text(COMPANY.name, rightX, 50, { width: 200, align: 'right' });
  doc.text(COMPANY.line1, rightX, 62, { width: 200, align: 'right' });
  doc.text(COMPANY.line2, rightX, 73, { width: 200, align: 'right' });
  doc.text(COMPANY.line3, rightX, 84, { width: 200, align: 'right' });
  doc.text(`${COMPANY.phone} · ${COMPANY.email}`, rightX, 95, { width: 200, align: 'right' });

  // Document title
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(title, 48, 120);

  // Divider line
  doc.moveTo(48, 145).lineTo(548, 145).strokeColor(LINE).lineWidth(0.6).stroke();

  doc.y = 158;
  return doc;
}

/** Helpers exposed to call-sites for consistent styling. */
export const colors = { INK, SOFT, DIM, LINE, SKY };
export const company = COMPANY;

/** Multi-line address block writer. Returns the y after the block. */
export function writeAddressBlock(doc, x, y, { name, line1, line2, city, county, postcode, country }) {
  const lines = [name, line1, line2, [city, county].filter(Boolean).join(', '), postcode, country].filter(Boolean);
  doc.fillColor(INK).font('Helvetica').fontSize(10);
  let cy = y;
  for (const l of lines) {
    doc.text(l, x, cy, { width: 240 });
    cy = doc.y;
  }
  return cy;
}

/** Two-column key/value rows for metadata block (e.g. DN#, date, customer). */
export function writeKv(doc, x, y, rows, opts = {}) {
  const labelW = opts.labelW || 90;
  doc.font('Helvetica').fontSize(9);
  let cy = y;
  for (const [label, value] of rows) {
    doc.fillColor(DIM).text(label, x, cy, { width: labelW });
    doc.fillColor(INK).font('Helvetica-Bold').text(String(value || '—'), x + labelW, cy, { width: 220 });
    doc.font('Helvetica');
    cy = doc.y + 2;
  }
  return cy;
}

/** Sends the doc as a streamed PDF response. */
export function sendPdf(doc, res, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/"/g, '')}"`);
  doc.pipe(res);
  doc.end();
}

/** Standard footer with page numbers + generated stamp. Call BEFORE doc.end(). */
export function applyPageFooter(doc, { dnNumber }) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.height - 32;
    doc.font('Helvetica').fontSize(7).fillColor(DIM);
    doc.text(
      `${dnNumber || ''} · Generated ${new Date().toLocaleString('en-GB')}`,
      48, bottom,
      { width: 300, align: 'left' }
    );
    doc.text(`Page ${i + 1} of ${range.count}`, 250, bottom, { width: 300, align: 'right' });
  }
}
