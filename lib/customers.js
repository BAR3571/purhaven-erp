import { sql } from './db.js';

export async function nextCustomerAccountCode() {
  const rows = await sql`SELECT MAX(id) AS max_id FROM erp_customers`;
  const next = (rows[0]?.max_id || 0) + 1;
  return `C-${String(next).padStart(5, '0')}`;
}

export async function getCustomerWithRelations(id) {
  const rows = await sql`
    SELECT * FROM erp_customers WHERE id = ${id} LIMIT 1
  `;
  if (rows.length === 0) return null;
  const customer = rows[0];

  const contacts = await sql`
    SELECT * FROM erp_customer_contacts
    WHERE customer_id = ${id}
    ORDER BY is_primary DESC, id ASC
  `;
  const addresses = await sql`
    SELECT * FROM erp_customer_addresses
    WHERE customer_id = ${id}
    ORDER BY is_default DESC, id ASC
  `;
  return { ...customer, contacts, addresses };
}
