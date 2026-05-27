import { sql } from '../../../lib/db.js';
import { requireUser } from '../../../lib/session.js';
import { sendDespatchEmail } from '../../../lib/despatch-email.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const to = (req.body?.to || '').trim() || null;
  try {
    const result = await sendDespatchEmail(id, { to, userId: user.id });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
