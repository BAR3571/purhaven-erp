import { sql } from '../../../lib/db.js';
import { requireUser } from '../../../lib/session.js';

// POST /api/despatches/[id]/parcels — replaces the parcel set for a despatch.
// Body: { parcels: [ { parcel_no, label?, pallet_label?, weight_kg?, length_cm?, width_cm?, height_cm?, notes?,
//                     items: [ { despatch_line_id, qty } ] } ] }
//
// Validates that the total qty per despatch_line_id across all parcels
// doesn't exceed that line's qty_picked (or qty_to_despatch if no picking yet).

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Refuse if despatched/cancelled
  const dnRows = await sql`SELECT status FROM erp_despatches WHERE id = ${id} LIMIT 1`;
  if (dnRows.length === 0) return res.status(404).json({ error: 'Despatch not found' });
  if (['despatched', 'cancelled'].includes(dnRows[0].status)) {
    return res.status(409).json({ error: `Cannot edit parcels on a ${dnRows[0].status} despatch` });
  }

  const parcels = Array.isArray(req.body?.parcels) ? req.body.parcels : [];
  if (parcels.length === 0) return res.status(400).json({ error: 'parcels array required' });

  // Cap totals so we don't over-pack
  const lineRows = await sql`
    SELECT id, qty_picked, qty_to_despatch
    FROM erp_despatch_lines WHERE despatch_id = ${id}
  `;
  const lineMax = Object.fromEntries(
    lineRows.map(l => [l.id, l.qty_picked > 0 ? l.qty_picked : l.qty_to_despatch])
  );

  const usage = {};
  for (const p of parcels) {
    const items = Array.isArray(p.items) ? p.items : [];
    for (const it of items) {
      const dnlId = parseInt(it.despatch_line_id, 10);
      const qty = parseInt(it.qty, 10);
      if (!Number.isFinite(dnlId) || !Number.isFinite(qty) || qty < 1) {
        return res.status(400).json({ error: 'Each parcel item needs despatch_line_id + positive qty' });
      }
      if (!(dnlId in lineMax)) {
        return res.status(400).json({ error: `Despatch line ${dnlId} not on this despatch` });
      }
      usage[dnlId] = (usage[dnlId] || 0) + qty;
    }
  }
  for (const [dnlId, used] of Object.entries(usage)) {
    if (used > lineMax[dnlId]) {
      return res.status(409).json({ error: `Despatch line ${dnlId}: parcels total ${used} exceeds picked qty ${lineMax[dnlId]}` });
    }
  }

  // Replace-all: wipe existing parcels (cascade clears parcel_items)
  await sql`DELETE FROM erp_parcels WHERE despatch_id = ${id}`;

  let parcelNo = 0;
  const created = [];
  for (const p of parcels) {
    parcelNo += 1;
    const num = parseInt(p.parcel_no, 10) || parcelNo;
    const ins = await sql`
      INSERT INTO erp_parcels (
        despatch_id, parcel_no, label, pallet_label,
        weight_kg, length_cm, width_cm, height_cm, notes
      ) VALUES (
        ${id}, ${num}, ${p.label || null}, ${p.pallet_label || null},
        ${p.weight_kg == null || p.weight_kg === '' ? null : Number(p.weight_kg)},
        ${p.length_cm ? parseInt(p.length_cm, 10) : null},
        ${p.width_cm  ? parseInt(p.width_cm,  10) : null},
        ${p.height_cm ? parseInt(p.height_cm, 10) : null},
        ${p.notes || null}
      )
      RETURNING id
    `;
    const parcelId = ins[0].id;
    const items = Array.isArray(p.items) ? p.items : [];
    for (const it of items) {
      await sql`
        INSERT INTO erp_parcel_items (parcel_id, despatch_line_id, qty)
        VALUES (${parcelId}, ${parseInt(it.despatch_line_id, 10)}, ${parseInt(it.qty, 10)})
      `;
    }
    created.push({ id: parcelId, parcel_no: num });
  }

  // Sync despatch.number_of_packages to actual parcel count
  await sql`UPDATE erp_despatches SET number_of_packages = ${created.length} WHERE id = ${id}`;

  return res.status(200).json({ ok: true, parcels: created });
}
