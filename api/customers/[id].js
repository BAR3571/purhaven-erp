import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';
import { getCustomerWithRelations } from '../../lib/customers.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  if (req.method === 'GET') {
    const customer = await getCustomerWithRelations(id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    return res.status(200).json({ ok: true, customer });
  }

  if (req.method === 'PUT') {
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const rows = await sql`
      UPDATE erp_customers SET
        name = ${name},
        vat_number = ${b.vat_number || null},
        eori_number = ${b.eori_number || null},
        currency = ${b.currency || 'GBP'},
        payment_terms = ${b.payment_terms || null},
        credit_limit_pence = ${b.credit_limit_pence ?? null},
        credit_hold = ${!!b.credit_hold},
        notes = ${b.notes || null},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Customer not found' });
    return res.status(200).json({ ok: true, customer: rows[0] });
  }

  if (req.method === 'DELETE') {
    const rows = await sql`
      UPDATE erp_customers SET active = FALSE, updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, active
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Customer not found' });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
