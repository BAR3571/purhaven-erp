import { sql } from '../../../../lib/db.js';
import { requireUser } from '../../../../lib/session.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const supplierId = parseInt(req.query.id, 10);
  const addressId = parseInt(req.query.aid, 10);
  if (!Number.isFinite(supplierId) || !Number.isFinite(addressId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  if (req.method === 'PUT') {
    const b = req.body || {};
    const type = ['billing', 'shipping', 'both'].includes(b.type) ? b.type : 'both';

    if (b.is_default) {
      await sql`
        UPDATE erp_supplier_addresses
        SET is_default = FALSE
        WHERE supplier_id = ${supplierId} AND id <> ${addressId}
      `;
    }

    const rows = await sql`
      UPDATE erp_supplier_addresses SET
        label = ${b.label || null},
        type = ${type},
        line1 = ${b.line1 || null},
        line2 = ${b.line2 || null},
        city = ${b.city || null},
        county = ${b.county || null},
        postcode = ${b.postcode || null},
        country = ${b.country || 'GB'},
        is_default = ${!!b.is_default}
      WHERE id = ${addressId} AND supplier_id = ${supplierId}
      RETURNING *
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Address not found' });
    return res.status(200).json({ ok: true, address: rows[0] });
  }

  if (req.method === 'DELETE') {
    const rows = await sql`
      DELETE FROM erp_supplier_addresses
      WHERE id = ${addressId} AND supplier_id = ${supplierId}
      RETURNING id
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Address not found' });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
