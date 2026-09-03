import { neon } from '@neondatabase/serverless';

// POST /api/admin/wipe-test-data
// Body: { "confirm": "WIPE-TEST-DATA" }
// Header: Authorization: Bearer <MIGRATION_TOKEN>
//
// Nukes all transactional / party data so you can start clean.
// Preserves: users, sessions, audit log, warehouses, products, bank accounts,
// expense categories, expenses, Xero + Revolut tokens.
//
// Wipes: customers (+contacts, addresses), suppliers (+contacts, addresses),
// sales orders (+lines), purchase orders (+lines), goods-in (+lines),
// despatches (+lines, parcels, parcel_items), so_po_allocations,
// stock_levels, stock_movements, product_serials, bank_transactions,
// archived_documents.
//
// All SERIAL sequences reset to 1 so the next SO is SO-000001 again.
//
// IMPORTANT: We use DELETE (not TRUNCATE CASCADE) because TRUNCATE CASCADE
// cascades to ANY table that FK-references the target, ignoring ON DELETE
// clauses. erp_products has manufacturer_id -> erp_suppliers(id), so a naive
// TRUNCATE erp_suppliers CASCADE would ALSO truncate erp_products. That has
// bitten us once already — never again.

// Order matters: children first, then parents. If you add a new table, put
// it above its parent.
const WIPE_TABLES = [
  'erp_parcel_items', 'erp_parcels',
  'erp_despatch_lines', 'erp_despatches',
  'erp_goods_in_lines', 'erp_goods_in',
  'erp_so_po_allocations',
  'erp_sales_order_lines', 'erp_sales_orders',
  'erp_purchase_order_lines', 'erp_purchase_orders',
  'erp_stock_movements', 'erp_product_serials', 'erp_stock_levels',
  'erp_bank_transactions',
  'erp_customer_contacts', 'erp_customer_addresses', 'erp_customers',
  // Suppliers last because erp_products.manufacturer_id references them;
  // DELETE (unlike TRUNCATE CASCADE) respects ON DELETE SET NULL so
  // products survive with manufacturer_id NULLed.
  'erp_supplier_contacts', 'erp_supplier_addresses', 'erp_suppliers',
  'erp_archived_documents'
];

// Sequences to reset so IDs start at 1 again.
const SEQUENCES_TO_RESET = [
  'erp_parcel_items_id_seq', 'erp_parcels_id_seq',
  'erp_despatch_lines_id_seq', 'erp_despatches_id_seq',
  'erp_goods_in_lines_id_seq', 'erp_goods_in_id_seq',
  'erp_so_po_allocations_id_seq',
  'erp_sales_order_lines_id_seq', 'erp_sales_orders_id_seq',
  'erp_purchase_order_lines_id_seq', 'erp_purchase_orders_id_seq',
  'erp_stock_movements_id_seq', 'erp_product_serials_id_seq', 'erp_stock_levels_id_seq',
  'erp_bank_transactions_id_seq',
  'erp_customer_contacts_id_seq', 'erp_customer_addresses_id_seq', 'erp_customers_id_seq',
  'erp_supplier_contacts_id_seq', 'erp_supplier_addresses_id_seq', 'erp_suppliers_id_seq',
  'erp_archived_documents_id_seq'
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST required' });
  }

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !process.env.MIGRATION_TOKEN || token !== process.env.MIGRATION_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized — Bearer MIGRATION_TOKEN required' });
  }

  const body = req.body || {};
  if (body.confirm !== 'WIPE-TEST-DATA') {
    return res.status(400).json({
      error: 'Send { "confirm": "WIPE-TEST-DATA" } in body to proceed. This will erase all customers, suppliers, orders, stock and bank transactions.'
    });
  }

  const sql = neon(process.env.DATABASE_URL);
  const before = await countAll(sql);
  const productsBefore = await countProducts(sql);

  try {
    // DELETE in FK-safe order, then reset sequences. NEVER use TRUNCATE
    // CASCADE here — it would cascade through manufacturer_id and wipe
    // erp_products.
    for (const t of WIPE_TABLES) {
      await sql(`DELETE FROM ${t}`);
    }
    for (const seq of SEQUENCES_TO_RESET) {
      try { await sql(`ALTER SEQUENCE ${seq} RESTART WITH 1`); } catch { /* sequence may not exist */ }
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, before });
  }

  const after = await countAll(sql);
  const productsAfter = await countProducts(sql);

  // Sanity check: products must not have changed.
  if (productsAfter !== productsBefore) {
    return res.status(500).json({
      ok: false,
      error: `Products count changed from ${productsBefore} to ${productsAfter} — aborting.`,
      before, after
    });
  }
  return res.status(200).json({
    ok: true,
    wiped_tables: WIPE_TABLES,
    kept_tables: [
      'erp_users', 'erp_sessions', 'erp_audit_log',
      'erp_warehouses', 'erp_products',
      'erp_bank_accounts', 'erp_expense_categories', 'erp_expenses',
      'erp_xero_tokens', 'erp_revolut_tokens'
    ],
    before, after
  });
}

async function countAll(sql) {
  const counts = {};
  for (const t of WIPE_TABLES) {
    try {
      const [{ n }] = await sql(`SELECT COUNT(*)::int AS n FROM ${t}`);
      counts[t] = n;
    } catch {
      counts[t] = null; // table may not exist yet in some envs
    }
  }
  return counts;
}

async function countProducts(sql) {
  try {
    const [{ n }] = await sql(`SELECT COUNT(*)::int AS n FROM erp_products`);
    return n;
  } catch { return null; }
}
