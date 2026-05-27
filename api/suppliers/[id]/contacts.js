import { sql } from '../../../lib/db.js';
import { requireUser } from '../../../lib/session.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const supplierId = parseInt(req.query.id, 10);
  if (!Number.isFinite(supplierId)) return res.status(400).json({ error: 'Invalid supplier id' });

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const b = req.body || {};
  const name = (b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Contact name is required' });

  if (b.is_primary) {
    await sql`UPDATE erp_supplier_contacts SET is_primary = FALSE WHERE supplier_id = ${supplierId}`;
  }

  const rows = await sql`
    INSERT INTO erp_supplier_contacts (supplier_id, name, email, phone, position, is_primary)
    VALUES (
      ${supplierId},
      ${name},
      ${b.email || null},
      ${b.phone || null},
      ${b.position || null},
      ${!!b.is_primary}
    )
    RETURNING *
  `;
  return res.status(201).json({ ok: true, contact: rows[0] });
}
