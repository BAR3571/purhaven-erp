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

  `CREATE INDEX IF NOT EXISTS erp_customer_addresses_cust_idx ON erp_customer_addresses(customer_id)`
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
