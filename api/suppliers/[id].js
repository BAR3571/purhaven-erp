import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';
import { getSupplierWithRelations } from '../../lib/suppliers.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  if (req.method === 'GET') {
    const supplier = await getSupplierWithRelations(id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    return res.status(200).json({ ok: true, supplier });
  }

  if (req.method === 'PUT') {
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const rows = await sql`
      UPDATE erp_suppliers SET
        name = ${name},
        vat_number = ${b.vat_number || null},
        eori_number = ${b.eori_number || null},
        currency = ${b.currency || 'GBP'},
        payment_terms = ${b.payment_terms || null},
        lead_time_days = ${b.lead_time_days ?? null},
        notes = ${b.notes || null},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Supplier not found' });
    return res.status(200).json({ ok: true, supplier: rows[0] });
  }

  if (req.method === 'DELETE') {
    const rows = await sql`
      UPDATE erp_suppliers SET active = FALSE, updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, active
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Supplier not found' });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
