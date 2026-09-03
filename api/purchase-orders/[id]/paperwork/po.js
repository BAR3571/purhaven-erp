import { requireUser } from '../../../../lib/session.js';
import { renderPoBuffer } from '../../../../lib/po-pdf.js';

// GET /api/purchase-orders/:id/paperwork/po — returns the PO as an inline PDF
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const { buffer, po } = await renderPoBuffer(id);
  if (!buffer) return res.status(404).json({ error: 'Purchase order not found' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${po.po_number}.pdf"`);
  return res.send(buffer);
}
