import { requireUser } from '../../../lib/session.js';
import { sendPoEmail } from '../../../lib/po-email.js';

// POST /api/purchase-orders/:id/email
// Body (optional): { to: "override@example.com" }
// Emails the PO PDF to the supplier's primary contact (or opts.to override),
// archives the PDF to OneDrive, and stamps po_email_sent_at.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const to = (req.body?.to || '').trim() || undefined;

  try {
    const result = await sendPoEmail(id, { to, userId: user.id });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
