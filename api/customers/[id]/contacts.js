import { sql } from '../../../lib/db.js';
import { requireUser } from '../../../lib/session.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const customerId = parseInt(req.query.id, 10);
  if (!Number.isFinite(customerId)) return res.status(400).json({ error: 'Invalid customer id' });

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const b = req.body || {};
  const name = (b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Contact name is required' });

  if (b.is_primary) {
    await sql`UPDATE erp_customer_contacts SET is_primary = FALSE WHERE customer_id = ${customerId}`;
  }

  const rows = await sql`
    INSERT INTO erp_customer_contacts (customer_id, name, email, phone, position, is_primary)
    VALUES (
      ${customerId},
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
