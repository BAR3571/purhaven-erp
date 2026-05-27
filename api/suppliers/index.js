import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';
import { nextSupplierAccountCode } from '../../lib/suppliers.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const q = (req.query.q || '').trim();
    const includeInactive = req.query.includeInactive === '1';

    const rows = includeInactive
      ? (q
          ? await sql`
              SELECT s.*,
                (SELECT COUNT(*) FROM erp_supplier_contacts WHERE supplier_id = s.id) AS contact_count,
                (SELECT COUNT(*) FROM erp_supplier_addresses WHERE supplier_id = s.id) AS address_count
              FROM erp_suppliers s
              WHERE s.name ILIKE ${'%' + q + '%'}
                 OR s.account_code ILIKE ${'%' + q + '%'}
                 OR s.vat_number ILIKE ${'%' + q + '%'}
              ORDER BY s.name ASC
            `
          : await sql`
              SELECT s.*,
                (SELECT COUNT(*) FROM erp_supplier_contacts WHERE supplier_id = s.id) AS contact_count,
                (SELECT COUNT(*) FROM erp_supplier_addresses WHERE supplier_id = s.id) AS address_count
              FROM erp_suppliers s
              ORDER BY s.name ASC
            `)
      : (q
          ? await sql`
              SELECT s.*,
                (SELECT COUNT(*) FROM erp_supplier_contacts WHERE supplier_id = s.id) AS contact_count,
                (SELECT COUNT(*) FROM erp_supplier_addresses WHERE supplier_id = s.id) AS address_count
              FROM erp_suppliers s
              WHERE s.active = TRUE
                AND (s.name ILIKE ${'%' + q + '%'}
                     OR s.account_code ILIKE ${'%' + q + '%'}
                     OR s.vat_number ILIKE ${'%' + q + '%'})
              ORDER BY s.name ASC
            `
          : await sql`
              SELECT s.*,
                (SELECT COUNT(*) FROM erp_supplier_contacts WHERE supplier_id = s.id) AS contact_count,
                (SELECT COUNT(*) FROM erp_supplier_addresses WHERE supplier_id = s.id) AS address_count
              FROM erp_suppliers s
              WHERE s.active = TRUE
              ORDER BY s.name ASC
            `);

    return res.status(200).json({ ok: true, suppliers: rows });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const accountCode = (b.account_code || '').trim() || (await nextSupplierAccountCode());

    try {
      const rows = await sql`
        INSERT INTO erp_suppliers (
          account_code, name, vat_number, eori_number, currency,
          payment_terms, lead_time_days, notes, created_by
        ) VALUES (
          ${accountCode},
          ${name},
          ${b.vat_number || null},
          ${b.eori_number || null},
          ${b.currency || 'GBP'},
          ${b.payment_terms || null},
          ${b.lead_time_days ?? null},
          ${b.notes || null},
          ${user.id}
        )
        RETURNING *
      `;
      return res.status(201).json({ ok: true, supplier: rows[0] });
    } catch (err) {
      if (err.message?.includes('erp_suppliers_account_code_key')) {
        return res.status(409).json({ error: `Account code ${accountCode} already exists` });
      }
      return res.status(500).json({ error: err.message });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
