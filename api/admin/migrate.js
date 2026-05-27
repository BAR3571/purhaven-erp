import { neon } from '@neondatabase/serverless';

const MIGRATIONS = [
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,

  `CREATE TABLE IF NOT EXISTS erp_users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','director')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
  )`,

  `CREATE TABLE IF NOT EXISTS erp_sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES erp_users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    user_agent TEXT,
    ip TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS erp_sessions_user_idx ON erp_sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS erp_sessions_expires_idx ON erp_sessions(expires_at)`,

  `CREATE TABLE IF NOT EXISTS erp_audit_log (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES erp_users(id),
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    action TEXT NOT NULL,
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS erp_audit_entity_idx ON erp_audit_log(entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS erp_audit_created_idx ON erp_audit_log(created_at DESC)`,

  // ---------- Customers (Phase 1 · Task #45) ----------
  `CREATE TABLE IF NOT EXISTS erp_customers (
    id SERIAL PRIMARY KEY,
    account_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    vat_number TEXT,
    eori_number TEXT,
    currency TEXT NOT NULL DEFAULT 'GBP',
    payment_terms TEXT,
    credit_limit_pence INTEGER,
    credit_hold BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    xero_contact_id TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by INTEGER REFERENCES erp_users(id)
  )`,

  `CREATE INDEX IF NOT EXISTS erp_customers_active_idx ON erp_customers(active)`,
  `CREATE INDEX IF NOT EXISTS erp_customers_name_idx ON erp_customers(LOWER(name))`,

  `CREATE TABLE IF NOT EXISTS erp_customer_contacts (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES erp_customers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    position TEXT,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS erp_customer_contacts_cust_idx ON erp_customer_contacts(customer_id)`,

  `CREATE TABLE IF NOT EXISTS erp_customer_addresses (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES erp_customers(id) ON DELETE CASCADE,
    label TEXT,
    type TEXT NOT NULL DEFAULT 'both' CHECK (type IN ('billing','shipping','both')),
    line1 TEXT,
    line2 TEXT,
    city TEXT,
    county TEXT,
    postcode TEXT,
    country TEXT NOT NULL DEFAULT 'GB',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS erp_customer_addresses_cust_idx ON erp_customer_addresses(customer_id)`,

  // ---------- Suppliers (Phase 1 · Task #46) ----------
  `CREATE TABLE IF NOT EXISTS erp_suppliers (
    id SERIAL PRIMARY KEY,
    account_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    vat_number TEXT,
    eori_number TEXT,
    currency TEXT NOT NULL DEFAULT 'GBP',
    payment_terms TEXT,
    lead_time_days INTEGER,
    notes TEXT,
    xero_contact_id TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by INTEGER REFERENCES erp_users(id)
  )`,

  `CREATE INDEX IF NOT EXISTS erp_suppliers_active_idx ON erp_suppliers(active)`,
  `CREATE INDEX IF NOT EXISTS erp_suppliers_name_idx ON erp_suppliers(LOWER(name))`,

  `CREATE TABLE IF NOT EXISTS erp_supplier_contacts (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER NOT NULL REFERENCES erp_suppliers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    position TEXT,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS erp_supplier_contacts_supp_idx ON erp_supplier_contacts(supplier_id)`,

  `CREATE TABLE IF NOT EXISTS erp_supplier_addresses (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER NOT NULL REFERENCES erp_suppliers(id) ON DELETE CASCADE,
    label TEXT,
    type TEXT NOT NULL DEFAULT 'both' CHECK (type IN ('billing','shipping','both')),
    line1 TEXT,
    line2 TEXT,
    city TEXT,
    county TEXT,
    postcode TEXT,
    country TEXT NOT NULL DEFAULT 'GB',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS erp_supplier_addresses_supp_idx ON erp_supplier_addresses(supplier_id)`,

  // ---------- Warehouses + Products & Stock (Phase 1 · Task #47) ----------
  `CREATE TABLE IF NOT EXISTS erp_warehouses (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'own' CHECK (type IN ('own','consignment','third_party')),
    notes TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `INSERT INTO erp_warehouses (code, name, type)
     VALUES ('MAIN', 'Main Stock — High Ongar', 'own')
     ON CONFLICT (code) DO NOTHING`,

  `CREATE TABLE IF NOT EXISTS erp_products (
    id SERIAL PRIMARY KEY,
    sku TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT,
    brand TEXT,
    parent_id INTEGER REFERENCES erp_products(id) ON DELETE SET NULL,
    manufacturer_id INTEGER REFERENCES erp_suppliers(id) ON DELETE SET NULL,
    barcode TEXT,
    ean TEXT,
    hs_code TEXT,
    country_of_origin TEXT,
    weight_g INTEGER,
    width_mm INTEGER,
    height_mm INTEGER,
    depth_mm INTEGER,
    lead_time_weeks INTEGER,
    vat_rate_percent INTEGER NOT NULL DEFAULT 20,
    cost_price_pence INTEGER,
    sale_price_pence INTEGER,
    currency TEXT NOT NULL DEFAULT 'GBP',
    min_stock_level INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by INTEGER REFERENCES erp_users(id)
  )`,

  `CREATE INDEX IF NOT EXISTS erp_products_active_idx ON erp_products(active)`,
  `CREATE INDEX IF NOT EXISTS erp_products_brand_idx ON erp_products(brand)`,
  `CREATE INDEX IF NOT EXISTS erp_products_category_idx ON erp_products(category)`,
  `CREATE INDEX IF NOT EXISTS erp_products_parent_idx ON erp_products(parent_id)`,
  `CREATE INDEX IF NOT EXISTS erp_products_manufacturer_idx ON erp_products(manufacturer_id)`,

  `CREATE TABLE IF NOT EXISTS erp_stock_levels (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES erp_products(id) ON DELETE CASCADE,
    warehouse_id INTEGER NOT NULL REFERENCES erp_warehouses(id),
    qty_on_hand INTEGER NOT NULL DEFAULT 0,
    qty_allocated INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (product_id, warehouse_id)
  )`,

  `CREATE INDEX IF NOT EXISTS erp_stock_levels_product_idx ON erp_stock_levels(product_id)`,
  `CREATE INDEX IF NOT EXISTS erp_stock_levels_warehouse_idx ON erp_stock_levels(warehouse_id)`,

  `CREATE TABLE IF NOT EXISTS erp_stock_movements (
    id BIGSERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES erp_products(id),
    warehouse_id INTEGER NOT NULL REFERENCES erp_warehouses(id),
    movement_type TEXT NOT NULL CHECK (movement_type IN ('receipt','despatch','adjustment','transfer_in','transfer_out','return','allocation','deallocation')),
    qty INTEGER NOT NULL,
    reference_type TEXT,
    reference_id INTEGER,
    notes TEXT,
    created_by INTEGER REFERENCES erp_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS erp_stock_movements_product_idx ON erp_stock_movements(product_id)`,
  `CREATE INDEX IF NOT EXISTS erp_stock_movements_warehouse_idx ON erp_stock_movements(warehouse_id)`,
  `CREATE INDEX IF NOT EXISTS erp_stock_movements_ref_idx ON erp_stock_movements(reference_type, reference_id)`,
  `CREATE INDEX IF NOT EXISTS erp_stock_movements_created_idx ON erp_stock_movements(created_at DESC)`,

  // ---------- Product images + serials + service intervals (Task #58) ----------
  `ALTER TABLE erp_products ADD COLUMN IF NOT EXISTS image_url TEXT`,
  `ALTER TABLE erp_products ADD COLUMN IF NOT EXISTS requires_serial BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE erp_products ADD COLUMN IF NOT EXISTS service_interval_months INTEGER`,

  `CREATE TABLE IF NOT EXISTS erp_product_serials (
    id BIGSERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES erp_products(id),
    serial_number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_stock'
      CHECK (status IN ('in_stock','despatched','installed','replaced','returned','scrapped')),
    warehouse_id INTEGER REFERENCES erp_warehouses(id),
    parent_serial_id BIGINT REFERENCES erp_product_serials(id) ON DELETE SET NULL,
    received_at TIMESTAMPTZ,
    despatched_at TIMESTAMPTZ,
    despatched_to_customer_id INTEGER REFERENCES erp_customers(id),
    service_due_at DATE,
    service_done_at DATE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (product_id, serial_number)
  )`,

  `CREATE INDEX IF NOT EXISTS erp_serials_product_idx ON erp_product_serials(product_id)`,
  `CREATE INDEX IF NOT EXISTS erp_serials_status_idx ON erp_product_serials(status)`,
  `CREATE INDEX IF NOT EXISTS erp_serials_due_idx ON erp_product_serials(service_due_at)`,
  `CREATE INDEX IF NOT EXISTS erp_serials_customer_idx ON erp_product_serials(despatched_to_customer_id)`,
  `CREATE INDEX IF NOT EXISTS erp_serials_parent_idx ON erp_product_serials(parent_serial_id)`,

  // ---------- Sales Orders (Phase 1 · Task #48) ----------
  `CREATE TABLE IF NOT EXISTS erp_sales_orders (
    id SERIAL PRIMARY KEY,
    so_number TEXT UNIQUE NOT NULL,
    customer_id INTEGER NOT NULL REFERENCES erp_customers(id),
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft','confirmed','picking','part_despatched','despatched','invoiced','complete','on_hold','cancelled')),
    customer_ref TEXT,
    order_date DATE NOT NULL DEFAULT CURRENT_DATE,
    required_date DATE,
    ship_to_address_id INTEGER REFERENCES erp_customer_addresses(id),
    ship_to_name TEXT,
    ship_to_line1 TEXT,
    ship_to_line2 TEXT,
    ship_to_city TEXT,
    ship_to_county TEXT,
    ship_to_postcode TEXT,
    ship_to_country TEXT DEFAULT 'GB',
    bill_to_address_id INTEGER REFERENCES erp_customer_addresses(id),
    bill_to_name TEXT,
    bill_to_line1 TEXT,
    bill_to_line2 TEXT,
    bill_to_city TEXT,
    bill_to_county TEXT,
    bill_to_postcode TEXT,
    bill_to_country TEXT DEFAULT 'GB',
    currency TEXT NOT NULL DEFAULT 'GBP',
    subtotal_pence INTEGER NOT NULL DEFAULT 0,
    vat_pence INTEGER NOT NULL DEFAULT 0,
    total_pence INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    xero_invoice_id TEXT,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','website')),
    revolut_order_id TEXT,
    confirmed_at TIMESTAMPTZ,
    despatched_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by INTEGER REFERENCES erp_users(id)
  )`,

  `CREATE INDEX IF NOT EXISTS erp_so_customer_idx ON erp_sales_orders(customer_id)`,
  `CREATE INDEX IF NOT EXISTS erp_so_status_idx ON erp_sales_orders(status)`,
  `CREATE INDEX IF NOT EXISTS erp_so_order_date_idx ON erp_sales_orders(order_date DESC)`,
  `CREATE INDEX IF NOT EXISTS erp_so_revolut_idx ON erp_sales_orders(revolut_order_id)`,

  `CREATE TABLE IF NOT EXISTS erp_sales_order_lines (
    id SERIAL PRIMARY KEY,
    so_id INTEGER NOT NULL REFERENCES erp_sales_orders(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    product_id INTEGER REFERENCES erp_products(id),
    sku TEXT,
    description TEXT NOT NULL,
    quantity_ordered INTEGER NOT NULL DEFAULT 1,
    quantity_despatched INTEGER NOT NULL DEFAULT 0,
    unit_price_pence INTEGER NOT NULL DEFAULT 0,
    discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
    cost_price_pence INTEGER,
    vat_rate_percent INTEGER NOT NULL DEFAULT 20,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS erp_sol_so_idx ON erp_sales_order_lines(so_id)`,
  `CREATE INDEX IF NOT EXISTS erp_sol_product_idx ON erp_sales_order_lines(product_id)`,

  // ---------- Website import (Task #59): email + phone on customer for matching ----------
  `ALTER TABLE erp_customers ADD COLUMN IF NOT EXISTS email TEXT`,
  `ALTER TABLE erp_customers ADD COLUMN IF NOT EXISTS phone TEXT`,
  `CREATE INDEX IF NOT EXISTS erp_customers_email_idx ON erp_customers(LOWER(email))`,

  // ---------- Purchase Orders (Phase 1 · Task #49) ----------
  `CREATE TABLE IF NOT EXISTS erp_purchase_orders (
    id SERIAL PRIMARY KEY,
    po_number TEXT UNIQUE NOT NULL,
    supplier_id INTEGER NOT NULL REFERENCES erp_suppliers(id),
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft','released','part_received','received','closed','cancelled')),
    supplier_ref TEXT,
    order_date DATE NOT NULL DEFAULT CURRENT_DATE,
    expected_date DATE,
    deliver_to_warehouse_id INTEGER REFERENCES erp_warehouses(id),
    currency TEXT NOT NULL DEFAULT 'GBP',
    subtotal_pence INTEGER NOT NULL DEFAULT 0,
    vat_pence INTEGER NOT NULL DEFAULT 0,
    total_pence INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    xero_bill_id TEXT,
    released_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by INTEGER REFERENCES erp_users(id)
  )`,

  `CREATE INDEX IF NOT EXISTS erp_po_supplier_idx ON erp_purchase_orders(supplier_id)`,
  `CREATE INDEX IF NOT EXISTS erp_po_status_idx ON erp_purchase_orders(status)`,
  `CREATE INDEX IF NOT EXISTS erp_po_order_date_idx ON erp_purchase_orders(order_date DESC)`,

  `CREATE TABLE IF NOT EXISTS erp_purchase_order_lines (
    id SERIAL PRIMARY KEY,
    po_id INTEGER NOT NULL REFERENCES erp_purchase_orders(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    product_id INTEGER REFERENCES erp_products(id),
    sku TEXT,
    description TEXT NOT NULL,
    quantity_ordered INTEGER NOT NULL DEFAULT 1,
    quantity_received INTEGER NOT NULL DEFAULT 0,
    unit_cost_pence INTEGER NOT NULL DEFAULT 0,
    vat_rate_percent INTEGER NOT NULL DEFAULT 20,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS erp_pol_po_idx ON erp_purchase_order_lines(po_id)`,
  `CREATE INDEX IF NOT EXISTS erp_pol_product_idx ON erp_purchase_order_lines(product_id)`,

  // ---------- SO ↔ PO allocations (Task #60) ----------
  // Serial → SO line: a specific serialised unit reserved for a sales order line.
  `ALTER TABLE erp_product_serials ADD COLUMN IF NOT EXISTS allocated_to_so_line_id INTEGER REFERENCES erp_sales_order_lines(id) ON DELETE SET NULL`,
  `CREATE INDEX IF NOT EXISTS erp_serials_alloc_so_idx ON erp_product_serials(allocated_to_so_line_id)`,

  // PO line → SO line: a qty of incoming stock reserved against a sales order line.
  `CREATE TABLE IF NOT EXISTS erp_so_po_allocations (
    id SERIAL PRIMARY KEY,
    so_line_id INTEGER NOT NULL REFERENCES erp_sales_order_lines(id) ON DELETE CASCADE,
    po_line_id INTEGER NOT NULL REFERENCES erp_purchase_order_lines(id) ON DELETE CASCADE,
    qty INTEGER NOT NULL CHECK (qty > 0),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by INTEGER REFERENCES erp_users(id)
  )`,
  `CREATE INDEX IF NOT EXISTS erp_so_po_so_line_idx ON erp_so_po_allocations(so_line_id)`,
  `CREATE INDEX IF NOT EXISTS erp_so_po_po_line_idx ON erp_so_po_allocations(po_line_id)`
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !process.env.MIGRATION_TOKEN || token !== process.env.MIGRATION_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized — Bearer token required' });
  }

  const sql = neon(process.env.DATABASE_URL);
  const results = [];
  for (const m of MIGRATIONS) {
    try {
      await sql(m);
      results.push({ ok: true, sql: m.slice(0, 80) });
    } catch (err) {
      results.push({ ok: false, sql: m.slice(0, 80), error: err.message });
    }
  }
  return res.status(200).json({ ok: results.every(r => r.ok), results });
}
