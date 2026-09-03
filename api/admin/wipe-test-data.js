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

const WIPE_TABLES = [
  // children first (though CASCADE will handle them, list is documentation)
  'erp_parcel_items', 'erp_parcels',
  'erp_despatch_lines', 'erp_despatches',
  'erp_goods_in_lines', 'erp_goods_in',
  'erp_so_po_allocations',
  'erp_sales_order_lines', 'erp_sales_orders',
  'erp_purchase_order_lines', 'erp_purchase_orders',
  'erp_stock_movements', 'erp_product_serials', 'erp_stock_levels',
  'erp_bank_transactions',
  'erp_customer_contacts', 'erp_customer_addresses', 'erp_customers',
  'erp_supplier_contacts', 'erp_supplier_addresses', 'erp_suppliers',
  'erp_archived_documents'
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

  try {
    // Single TRUNCATE with all tables — atomic, resets SERIAL sequences.
    await sql(`TRUNCATE ${WIPE_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, before });
  }

  const after = await countAll(sql);
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
