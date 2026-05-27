import { sql } from '../../../../lib/db.js';
import { requireUser } from '../../../../lib/session.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const customerId = parseInt(req.query.id, 10);
  const contactId = parseInt(req.query.cid, 10);
  if (!Number.isFinite(customerId) || !Number.isFinite(contactId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  if (req.method === 'PUT') {
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Contact name is required' });

    if (b.is_primary) {
      await sql`
        UPDATE erp_customer_contacts
        SET is_primary = FALSE
        WHERE customer_id = ${customerId} AND id <> ${contactId}
      `;
    }

    const rows = await sql`
      UPDATE erp_customer_contacts SET
        name = ${name},
        email = ${b.email || null},
        phone = ${b.phone || null},
        position = ${b.position || null},
        is_primary = ${!!b.is_primary}
      WHERE id = ${contactId} AND customer_id = ${customerId}
      RETURNING *
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    return res.status(200).json({ ok: true, contact: rows[0] });
  }

  if (req.method === 'DELETE') {
    const rows = await sql`
      DELETE FROM erp_customer_contacts
      WHERE id = ${contactId} AND customer_id = ${customerId}
      RETURNING id
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
