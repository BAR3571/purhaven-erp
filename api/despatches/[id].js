import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';
import { getDespatchWithRelations, refreshSoFromDespatches } from '../../lib/despatch.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  if (req.method === 'GET') {
    const dn = await getDespatchWithRelations(id);
    if (!dn) return res.status(404).json({ error: 'Despatch not found' });
    return res.status(200).json({ ok: true, despatch: dn });
  }

  if (req.method === 'PUT') {
    const b = req.body || {};
    const existing = await sql`SELECT * FROM erp_despatches WHERE id = ${id} LIMIT 1`;
    if (existing.length === 0) return res.status(404).json({ error: 'Despatch not found' });
    const e = existing[0];
    if (['despatched', 'cancelled'].includes(e.status)) {
      return res.status(409).json({ error: `Cannot edit a ${e.status} despatch` });
    }

    const weightStr = b.weight_kg;
    const weightKg = weightStr === undefined ? e.weight_kg
                   : (weightStr === null || weightStr === '' ? null : Number(weightStr));

    const rows = await sql`
      UPDATE erp_despatches SET
        carrier = ${b.carrier === undefined ? e.carrier : (b.carrier || null)},
        tracking_number = ${b.tracking_number === undefined ? e.tracking_number : (b.tracking_number || null)},
        weight_kg = ${weightKg},
        number_of_packages = ${b.number_of_packages === undefined ? e.number_of_packages : (parseInt(b.number_of_packages, 10) || 1)},
        notes = ${b.notes === undefined ? e.notes : (b.notes || null)},
        assigned_picker_id = ${b.assigned_picker_id === undefined ? e.assigned_picker_id : (b.assigned_picker_id ? parseInt(b.assigned_picker_id, 10) : null)}
      WHERE id = ${id}
      RETURNING *
    `;
    return res.status(200).json({ ok: true, despatch: rows[0] });
  }

  if (req.method === 'DELETE') {
    const existing = await sql`SELECT status, so_id FROM erp_despatches WHERE id = ${id} LIMIT 1`;
    if (existing.length === 0) return res.status(404).json({ error: 'Despatch not found' });
    if (existing[0].status !== 'pending') {
      return res.status(409).json({ error: `Only pending despatches can be deleted (current status: ${existing[0].status})` });
    }
    await sql`DELETE FROM erp_despatches WHERE id = ${id}`;
    await refreshSoFromDespatches(existing[0].so_id);
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
