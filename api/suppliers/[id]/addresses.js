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
  const type = ['billing', 'shipping', 'both'].includes(b.type) ? b.type : 'both';

  if (b.is_default) {
    await sql`UPDATE erp_supplier_addresses SET is_default = FALSE WHERE supplier_id = ${supplierId}`;
  }

  const rows = await sql`
    INSERT INTO erp_supplier_addresses (
      supplier_id, label, type, line1, line2, city, county, postcode, country, is_default
    ) VALUES (
      ${supplierId},
      ${b.label || null},
      ${type},
      ${b.line1 || null},
      ${b.line2 || null},
      ${b.city || null},
      ${b.county || null},
      ${b.postcode || null},
      ${b.country || 'GB'},
      ${!!b.is_default}
    )
    RETURNING *
  `;
  return res.status(201).json({ ok: true, address: rows[0] });
}
