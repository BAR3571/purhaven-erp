// Xero OAuth + invoicing client. Stores long-lived refresh tokens in
// erp_xero_tokens (singleton row id=1). Access tokens are short-lived
// (30 min), so getAccessToken() auto-refreshes when needed.
//
// Required env vars (set in Vercel):
//   XERO_CLIENT_ID         — from your Xero app
//   XERO_CLIENT_SECRET     — from your Xero app
//   XERO_REDIRECT_URI      — e.g. https://purhaven-erp.vercel.app/api/admin/xero-callback
//
// Connect once via /api/admin/xero-connect. Tokens auto-refresh thereafter.

import { sql } from './db.js';

const SCOPES = [
  'openid', 'profile', 'email',
  'accounting.transactions',
  'accounting.contacts',
  'offline_access'  // required for refresh tokens
].join(' ');

const IDENTITY_BASE = 'https://identity.xero.com';
const API_BASE = 'https://api.xero.com';

export function isConfigured() {
  return !!(
    process.env.XERO_CLIENT_ID &&
    process.env.XERO_CLIENT_SECRET &&
    process.env.XERO_REDIRECT_URI
  );
}

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is not set`);
  return v;
}

/** Build the authorize URL the user is redirected to to grant consent. */
export function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: envOrThrow('XERO_CLIENT_ID'),
    redirect_uri: envOrThrow('XERO_REDIRECT_URI'),
    scope: SCOPES,
    state
  });
  return `${IDENTITY_BASE}/connect/authorize?${params.toString()}`;
}

/** Exchange the OAuth code for tokens (first-time connect). */
export async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: envOrThrow('XERO_REDIRECT_URI')
  });
  const r = await fetch(`${IDENTITY_BASE}/connect/token`, {
    method: 'POST',
    headers: {
      'Authorization': basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error('Xero token exchange failed: ' + (data.error_description || JSON.stringify(data)));
  }
  return data; // { access_token, refresh_token, expires_in, scope, ... }
}

/** Fetch the connected tenants (Xero organisations) — we use the first. */
export async function getConnectedTenants(accessToken) {
  const r = await fetch(`${API_BASE}/connections`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Xero connections fetch failed: ' + JSON.stringify(data));
  return data; // [{ id, tenantId, tenantType, tenantName, ... }]
}

/** Persist a freshly-acquired token set to erp_xero_tokens. */
export async function saveTokens({ tokens, tenantId, tenantName, userId }) {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  await sql`
    INSERT INTO erp_xero_tokens (
      id, tenant_id, tenant_name, access_token, refresh_token,
      expires_at, scope, connected_by, connected_at, updated_at
    ) VALUES (
      1, ${tenantId}, ${tenantName}, ${tokens.access_token}, ${tokens.refresh_token},
      ${expiresAt.toISOString()}, ${tokens.scope || null}, ${userId || null}, NOW(), NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      tenant_name = EXCLUDED.tenant_name,
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      expires_at = EXCLUDED.expires_at,
      scope = COALESCE(EXCLUDED.scope, erp_xero_tokens.scope),
      updated_at = NOW()
  `;
}

/** Returns the current token row, or null if Xero has never been connected. */
export async function getStoredTokens() {
  const rows = await sql`SELECT * FROM erp_xero_tokens WHERE id = 1`;
  return rows[0] || null;
}

/** Refresh the access token using the stored refresh_token. */
async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });
  const r = await fetch(`${IDENTITY_BASE}/connect/token`, {
    method: 'POST',
    headers: {
      'Authorization': basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Xero token refresh failed: ' + (data.error_description || JSON.stringify(data)));
  return data;
}

/** Returns { accessToken, tenantId } refreshing if needed. */
export async function getAccessToken() {
  const row = await getStoredTokens();
  if (!row) throw new Error('Xero is not connected — visit /api/admin/xero-connect to authorise.');

  // Refresh if expiring in less than 60s
  if (new Date(row.expires_at).getTime() - Date.now() < 60_000) {
    const fresh = await refreshAccessToken(row.refresh_token);
    const expiresAt = new Date(Date.now() + fresh.expires_in * 1000);
    await sql`
      UPDATE erp_xero_tokens SET
        access_token = ${fresh.access_token},
        refresh_token = ${fresh.refresh_token || row.refresh_token},
        expires_at = ${expiresAt.toISOString()},
        updated_at = NOW()
      WHERE id = 1
    `;
    return { accessToken: fresh.access_token, tenantId: row.tenant_id };
  }
  return { accessToken: row.access_token, tenantId: row.tenant_id };
}

function basicAuthHeader() {
  const id = envOrThrow('XERO_CLIENT_ID');
  const secret = envOrThrow('XERO_CLIENT_SECRET');
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

async function xeroFetch(path, options = {}) {
  const { accessToken, tenantId } = await getAccessToken();
  const r = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error(`Xero API ${r.status} ${path}: ${data?.Message || data?.Detail || JSON.stringify(data)}`);
  }
  return data;
}

/** Upsert a customer in Xero (matched by xero_contact_id if known, else by email/name).
 *  Returns the Xero ContactID and stamps it back onto the ERP customer row. */
export async function upsertCustomerContact(customer) {
  if (customer.xero_contact_id) {
    // Already linked — return as-is. Could refresh details here if needed.
    return customer.xero_contact_id;
  }

  const payload = {
    Contacts: [{
      Name: customer.name || customer.account_code,
      EmailAddress: customer.email || undefined,
      Phones: customer.phone ? [{ PhoneType: 'DEFAULT', PhoneNumber: customer.phone }] : undefined,
      Addresses: customer.address_line1 ? [{
        AddressType: 'POBOX',
        AddressLine1: customer.address_line1,
        AddressLine2: customer.address_line2 || undefined,
        City: customer.city || undefined,
        Region: customer.county || undefined,
        PostalCode: customer.postcode || undefined,
        Country: customer.country || 'GB'
      }] : undefined,
      AccountNumber: customer.account_code || undefined
    }]
  };

  const data = await xeroFetch('/api.xro/2.0/Contacts', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  const xeroContactId = data.Contacts?.[0]?.ContactID;
  if (!xeroContactId) throw new Error('Xero did not return a ContactID: ' + JSON.stringify(data));

  await sql`UPDATE erp_customers SET xero_contact_id = ${xeroContactId} WHERE id = ${customer.id}`;
  return xeroContactId;
}

/** Build + post an ACCREC (sales) invoice from a despatch + its SO header. */
export async function pushDespatchInvoice({ despatch, so, customer, lines }) {
  const xeroContactId = await upsertCustomerContact(customer);

  const lineItems = lines.map(l => ({
    Description: l.description || l.sku || 'Item',
    Quantity: Number(l.qty_despatched ?? l.quantity_ordered ?? 0),
    UnitAmount: Number((l.unit_price_pence || 0) / 100),
    AccountCode: '200', // Sales — most Xero accounts use 200 by default
    TaxType: 'OUTPUT2', // 20% VAT on Income (UK standard); Xero will pick a fallback if unknown
    DiscountRate: Number(l.discount_percent || 0) || undefined,
    ItemCode: l.sku || undefined
  }));

  const invoice = {
    Type: 'ACCREC',
    Contact: { ContactID: xeroContactId },
    Date: (despatch.despatched_at || new Date().toISOString()).slice(0, 10),
    DueDate: addDaysIso(despatch.despatched_at || new Date().toISOString(), 30),
    InvoiceNumber: despatch.despatch_number,
    Reference: so.so_number,
    Status: 'AUTHORISED', // post the invoice (vs DRAFT)
    LineAmountTypes: 'Exclusive',
    LineItems: lineItems,
    CurrencyCode: so.currency || 'GBP'
  };

  const data = await xeroFetch('/api.xro/2.0/Invoices', {
    method: 'POST',
    body: JSON.stringify({ Invoices: [invoice] })
  });
  const xeroInvoiceId = data.Invoices?.[0]?.InvoiceID;
  if (!xeroInvoiceId) throw new Error('Xero did not return an InvoiceID: ' + JSON.stringify(data));

  await sql`
    UPDATE erp_despatches
    SET xero_invoice_id = ${xeroInvoiceId}, xero_pushed_at = NOW()
    WHERE id = ${despatch.id}
  `;
  if (so?.id) {
    await sql`UPDATE erp_sales_orders SET xero_invoice_id = ${xeroInvoiceId} WHERE id = ${so.id}`;
  }
  return { xero_invoice_id: xeroInvoiceId, invoice_number: data.Invoices[0].InvoiceNumber };
}

function addDaysIso(isoLike, days) {
  const d = new Date(isoLike);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
