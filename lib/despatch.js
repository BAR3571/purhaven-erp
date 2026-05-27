import { sql } from './db.js';

export async function nextDespatchNumber() {
  const rows = await sql`SELECT MAX(id) AS max_id FROM erp_despatches`;
  const next = (rows[0]?.max_id || 0) + 1;
  return `DN-${String(next).padStart(5, '0')}`;
}

export async function getDespatchWithRelations(id) {
  const rows = await sql`
    SELECT dn.*,
           so.so_number, so.customer_ref, so.status AS so_status,
           so.ship_to_name, so.ship_to_line1, so.ship_to_line2,
           so.ship_to_city, so.ship_to_county, so.ship_to_postcode, so.ship_to_country,
           c.id AS customer_id, c.name AS customer_name, c.account_code AS customer_code, c.email AS customer_email,
           w.code AS warehouse_code, w.name AS warehouse_name,
           picker.name AS picker_name, picker.email AS picker_email
    FROM erp_despatches dn
    JOIN erp_sales_orders so ON so.id = dn.so_id
    JOIN erp_customers c ON c.id = so.customer_id
    LEFT JOIN erp_warehouses w ON w.id = dn.warehouse_id
    LEFT JOIN erp_users picker ON picker.id = dn.assigned_picker_id
    WHERE dn.id = ${id}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const dn = rows[0];

  const lines = await sql`
    SELECT dnl.*, sol.line_no AS so_line_no, sol.unit_price_pence, p.requires_serial,
           p.service_interval_months, p.image_url
    FROM erp_despatch_lines dnl
    LEFT JOIN erp_sales_order_lines sol ON sol.id = dnl.so_line_id
    LEFT JOIN erp_products p ON p.id = dnl.product_id
    WHERE dnl.despatch_id = ${id}
    ORDER BY dnl.id ASC
  `;

  // Serials assigned to this despatch (in_stock when picking, will flip to despatched on final confirm)
  const lineIds = lines.map(l => l.id);
  const serials = lineIds.length === 0 ? [] : await sql`
    SELECT id, serial_number, status, despatch_line_id, service_due_at
    FROM erp_product_serials
    WHERE despatch_line_id = ANY(${lineIds})
    ORDER BY serial_number ASC
  `;
  const byLine = {};
  for (const s of serials) (byLine[s.despatch_line_id] ||= []).push(s);
  for (const l of lines) l.assigned_serials = byLine[l.id] || [];

  // Parcels + their items
  const parcels = await sql`
    SELECT id, parcel_no, label, pallet_label, weight_kg, length_cm, width_cm, height_cm, notes
    FROM erp_parcels
    WHERE despatch_id = ${id}
    ORDER BY parcel_no ASC
  `;
  if (parcels.length > 0) {
    const parcelIds = parcels.map(p => p.id);
    const items = await sql`
      SELECT id, parcel_id, despatch_line_id, qty
      FROM erp_parcel_items
      WHERE parcel_id = ANY(${parcelIds})
    `;
    const byParcel = {};
    for (const i of items) (byParcel[i.parcel_id] ||= []).push(i);
    for (const p of parcels) p.items = byParcel[p.id] || [];
  }

  return { ...dn, lines, parcels };
}

/** Recompute SO status based on its despatches. Confirmed → picking when one starts; → despatched / part_despatched / complete when shipped. */
export async function refreshSoFromDespatches(soId) {
  const soRows = await sql`SELECT status FROM erp_sales_orders WHERE id = ${soId} LIMIT 1`;
  if (soRows.length === 0) return;
  const curStatus = soRows[0].status;
  if (['invoiced', 'complete', 'cancelled'].includes(curStatus)) return;

  // Sum qty_despatched per SO line via despatch_lines
  await sql`
    UPDATE erp_sales_order_lines sol
    SET quantity_despatched = COALESCE((
      SELECT SUM(qty_despatched) FROM erp_despatch_lines WHERE so_line_id = sol.id
    ), 0)
    WHERE sol.so_id = ${soId}
  `;

  const lines = await sql`SELECT quantity_ordered, quantity_despatched FROM erp_sales_order_lines WHERE so_id = ${soId}`;
  if (lines.length === 0) return;
  const allFull = lines.every(l => l.quantity_despatched >= l.quantity_ordered);
  const anyDespatched = lines.some(l => l.quantity_despatched > 0);

  // Are there any non-cancelled despatches in flight?
  const dnRows = await sql`
    SELECT status FROM erp_despatches WHERE so_id = ${soId} AND status <> 'cancelled'
  `;
  const anyActive = dnRows.length > 0;
  const anyShipped = dnRows.some(d => d.status === 'despatched');

  let newStatus = curStatus;
  if (allFull && anyShipped) newStatus = 'despatched';
  else if (anyDespatched && anyShipped) newStatus = 'part_despatched';
  else if (anyActive && curStatus === 'confirmed') newStatus = 'picking';

  if (newStatus !== curStatus) {
    await sql`UPDATE erp_sales_orders SET status = ${newStatus}, despatched_at = COALESCE(despatched_at, CASE WHEN ${newStatus} = 'despatched' THEN NOW() END), updated_at = NOW() WHERE id = ${soId}`;
  }
}

function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

export { addMonths };
