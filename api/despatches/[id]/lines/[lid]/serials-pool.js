import { sql } from '../../../../../lib/db.js';
import { requireUser } from '../../../../../lib/session.js';

// Candidate serials a picker can choose from for a given despatch line.
// Includes:
//  - in_stock serials for this product at this despatch's warehouse, AND
//  - any serials already assigned to this despatch line (so they can be unticked)
// Each row carries flags so the UI can pre-tick the right ones.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const dnId = parseInt(req.query.id, 10);
  const lineId = parseInt(req.query.lid, 10);
  if (!Number.isFinite(dnId) || !Number.isFinite(lineId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  const lineRows = await sql`
    SELECT dnl.product_id, dnl.so_line_id, dn.warehouse_id
    FROM erp_despatch_lines dnl
    JOIN erp_despatches dn ON dn.id = dnl.despatch_id
    WHERE dnl.id = ${lineId} AND dnl.despatch_id = ${dnId} LIMIT 1
  `;
  if (lineRows.length === 0) return res.status(404).json({ error: 'Despatch line not found' });
  const { product_id, so_line_id, warehouse_id } = lineRows[0];
  if (!product_id) return res.status(200).json({ ok: true, serials: [], note: 'Line has no product' });

  const serials = await sql`
    SELECT s.id, s.serial_number, s.status, s.warehouse_id,
           s.allocated_to_so_line_id, s.despatch_line_id,
           w.code AS warehouse_code
    FROM erp_product_serials s
    LEFT JOIN erp_warehouses w ON w.id = s.warehouse_id
    WHERE s.product_id = ${product_id}
      AND (
            (s.status = 'in_stock' AND s.warehouse_id = ${warehouse_id})
         OR (s.despatch_line_id = ${lineId})
      )
    ORDER BY
      (s.despatch_line_id = ${lineId}) DESC,
      (s.allocated_to_so_line_id = ${so_line_id}) DESC,
      (s.allocated_to_so_line_id IS NULL) ASC,
      s.serial_number ASC
  `;

  const out = serials.map(s => ({
    id: s.id,
    serial_number: s.serial_number,
    status: s.status,
    warehouse_code: s.warehouse_code,
    is_allocated_to_this_line: s.allocated_to_so_line_id === so_line_id,
    is_assigned_to_this_despatch_line: s.despatch_line_id === lineId,
    is_allocated_elsewhere: s.allocated_to_so_line_id != null && s.allocated_to_so_line_id !== so_line_id
  }));

  return res.status(200).json({ ok: true, serials: out });
}
