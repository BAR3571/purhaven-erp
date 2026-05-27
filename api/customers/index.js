import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';
import { nextCustomerAccountCode } from '../../lib/customers.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const q = (req.query.q || '').trim();
    const includeInactive = req.query.includeInactive === '1';

    const rows = includeInactive
      ? (q
          ? await sql`
              SELECT c.*,
                (SELECT COUNT(*) FROM erp_customer_contacts WHERE customer_id = c.id) AS contact_count,
                (SELECT COUNT(*) FROM erp_customer_addresses WHERE customer_id = c.id) AS address_count
              FROM erp_customers c
              WHERE c.name ILIKE ${'%' + q + '%'}
                 OR c.account_code ILIKE ${'%' + q + '%'}
                 OR c.vat_number ILIKE ${'%' + q + '%'}
              ORDER BY c.name ASC
            `
          : await sql`
              SELECT c.*,
                (SELECT COUNT(*) FROM erp_customer_contacts WHERE customer_id = c.id) AS contact_count,
                (SELECT COUNT(*) FROM erp_customer_addresses WHERE customer_id = c.id) AS address_count
              FROM erp_customers c
              ORDER BY c.name ASC
            `)
      : (q
          ? await sql`
              SELECT c.*,
                (SELECT COUNT(*) FROM erp_customer_contacts WHERE customer_id = c.id) AS contact_count,
                (SELECT COUNT(*) FROM erp_customer_addresses WHERE customer_id = c.id) AS address_count
              FROM erp_customers c
              WHERE c.active = TRUE
                AND (c.name ILIKE ${'%' + q + '%'}
                     OR c.account_code ILIKE ${'%' + q + '%'}
                     OR c.vat_number ILIKE ${'%' + q + '%'})
              ORDER BY c.name ASC
            `
          : await sql`
              SELECT c.*,
                (SELECT COUNT(*) FROM erp_customer_contacts WHERE customer_id = c.id) AS contact_count,
                (SELECT COUNT(*) FROM erp_customer_addresses WHERE customer_id = c.id) AS address_count
              FROM erp_customers c
              WHERE c.active = TRUE
              ORDER BY c.name ASC
            `);

    return res.status(200).json({ ok: true, customers: rows });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const accountCode = (b.account_code || '').trim() || (await nextCustomerAccountCode());

    try {
      const rows = await sql`
        INSERT INTO erp_customers (
          account_code, name, vat_number, eori_number, currency,
          payment_terms, credit_limit_pence, credit_hold, notes, created_by
        ) VALUES (
          ${accountCode},
          ${name},
          ${b.vat_number || null},
          ${b.eori_number || null},
          ${b.currency || 'GBP'},
          ${b.payment_terms || null},
          ${b.credit_limit_pence ?? null},
          ${!!b.credit_hold},
          ${b.notes || null},
          ${user.id}
        )
        RETURNING *
      `;
      return res.status(201).json({ ok: true, customer: rows[0] });
    } catch (err) {
      if (err.message?.includes('erp_customers_account_code_key')) {
        return res.status(409).json({ error: `Account code ${accountCode} already exists` });
      }
      return res.status(500).json({ error: err.message });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
