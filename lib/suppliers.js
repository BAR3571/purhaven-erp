import { sql } from './db.js';

export async function nextSupplierAccountCode() {
  const rows = await sql`SELECT MAX(id) AS max_id FROM erp_suppliers`;
  const next = (rows[0]?.max_id || 0) + 1;
  return `S-${String(next).padStart(5, '0')}`;
}

export async function getSupplierWithRelations(id) {
  const rows = await sql`SELECT * FROM erp_suppliers WHERE id = ${id} LIMIT 1`;
  if (rows.length === 0) return null;
  const supplier = rows[0];

  const contacts = await sql`
    SELECT * FROM erp_supplier_contacts
    WHERE supplier_id = ${id}
    ORDER BY is_primary DESC, id ASC
  `;
  const addresses = await sql`
    SELECT * FROM erp_supplier_addresses
    WHERE supplier_id = ${id}
    ORDER BY is_default DESC, id ASC
  `;
  return { ...supplier, contacts, addresses };
}
