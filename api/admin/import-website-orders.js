import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';
import { getPurhavenSiteSql } from '../../lib/purhaven-site.js';
import { nextSoNumber, recomputeSoTotals } from '../../lib/sales-orders.js';
import { nextCustomerAccountCode } from '../../lib/customers.js';

const IMPORTABLE_STATUSES = ['paid', 'processing', 'fulfilled', 'shipped', 'delivered'];

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  let siteSql;
  try { siteSql = getPurhavenSiteSql(); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  // Pull paid+ orders from the website with customer + items
  let websiteOrders;
  try {
    websiteOrders = await siteSql`
      SELECT
        o.id::text                AS website_order_id,
        o.revolut_order_id,
        o.status                  AS website_status,
        o.total_pence,
        o.ship_to_name, o.ship_to_address_1, o.ship_to_address_2,
        o.ship_to_city, o.ship_to_postcode, o.ship_to_country,
        o.tracking_number, o.tracking_carrier, o.notes,
        o.created_at, o.paid_at,
        c.email                   AS customer_email,
        c.name                    AS customer_name_from_db,
        c.phone                   AS customer_phone
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.status = ANY(${IMPORTABLE_STATUSES})
      ORDER BY o.created_at DESC
      LIMIT 500
    `;
  } catch (err) {
    return res.status(500).json({ error: 'Could not read website DB: ' + err.message });
  }

  if (websiteOrders.length === 0) {
    return res.status(200).json({ ok: true, imported: 0, skipped: 0, errors: [], note: 'No importable website orders found.' });
  }

  // Pull line items in one go
  const orderIds = websiteOrders.map(o => o.website_order_id);
  const items = await siteSql`
    SELECT
      order_id::text AS order_id,
      qty, unit_price_pence, product_id, product_name, product_brand
    FROM order_items
    WHERE order_id::text = ANY(${orderIds})
  `;
  const itemsByOrder = {};
  for (const it of items) {
    (itemsByOrder[it.order_id] ||= []).push(it);
  }

  const out = { imported: 0, skipped: 0, errors: [] };

  for (const wo of websiteOrders) {
    try {
      // Skip if already imported (by revolut_order_id)
      const dup = await sql`
        SELECT id FROM erp_sales_orders WHERE revolut_order_id = ${wo.revolut_order_id} LIMIT 1
      `;
      if (dup.length > 0) { out.skipped++; continue; }

      // Find or create customer by email
      const email = (wo.customer_email || '').toLowerCase().trim() || null;
      const custName = wo.ship_to_name || wo.customer_name_from_db || email || 'Website customer';
      let customerId = null;
      if (email) {
        const found = await sql`SELECT id FROM erp_customers WHERE LOWER(email) = ${email} LIMIT 1`;
        if (found.length > 0) customerId = found[0].id;
      }
      if (!customerId) {
        const code = await nextCustomerAccountCode();
        const inserted = await sql`
          INSERT INTO erp_customers (account_code, name, email, phone, currency, created_by)
          VALUES (${code}, ${custName}, ${email}, ${wo.customer_phone || null}, 'GBP', ${user.id})
          RETURNING id
        `;
        customerId = inserted[0].id;
      }

      // Map website status → ERP SO status
      const soStatus = ({
        paid: 'confirmed',
        processing: 'confirmed',
        fulfilled: 'despatched',
        shipped: 'despatched',
        delivered: 'complete'
      })[wo.website_status] || 'draft';

      const soNumber = await nextSoNumber();
      const orderDate = wo.paid_at || wo.created_at;

      const soRows = await sql`
        INSERT INTO erp_sales_orders (
          so_number, customer_id, status,
          order_date, ship_to_name, ship_to_line1, ship_to_line2,
          ship_to_city, ship_to_postcode, ship_to_country,
          currency, notes,
          source, revolut_order_id,
          confirmed_at,
          created_by
        ) VALUES (
          ${soNumber}, ${customerId}, ${soStatus},
          COALESCE(${orderDate}::date, CURRENT_DATE),
          ${wo.ship_to_name || custName},
          ${wo.ship_to_address_1 || null},
          ${wo.ship_to_address_2 || null},
          ${wo.ship_to_city || null},
          ${wo.ship_to_postcode || null},
          ${wo.ship_to_country || 'GB'},
          'GBP',
          ${wo.notes || null},
          'website',
          ${wo.revolut_order_id},
          ${soStatus === 'draft' ? null : (wo.paid_at || wo.created_at)},
          ${user.id}
        )
        RETURNING id
      `;
      const soId = soRows[0].id;

      // Lines — snapshot only (no ERP product link); user can manually relink later
      const lines = itemsByOrder[wo.website_order_id] || [];
      let lineNo = 1;
      for (const li of lines) {
        // Website prices are inc-VAT. Strip 20% to store ex-VAT on the line.
        const unitExVat = Math.round((li.unit_price_pence || 0) / 1.2);
        const desc = [li.product_brand, li.product_name].filter(Boolean).join(' — ');
        await sql`
          INSERT INTO erp_sales_order_lines (
            so_id, line_no, product_id, sku, description,
            quantity_ordered, unit_price_pence, vat_rate_percent
          ) VALUES (
            ${soId}, ${lineNo}, NULL, ${li.product_id || null}, ${desc || 'Item'},
            ${li.qty || 1}, ${unitExVat}, 20
          )
        `;
        lineNo++;
      }
      await recomputeSoTotals(soId);

      out.imported++;
    } catch (err) {
      out.errors.push({
        website_order_id: wo.website_order_id,
        revolut_order_id: wo.revolut_order_id,
        error: err.message
      });
    }
  }

  return res.status(200).json({ ok: true, ...out });
}
