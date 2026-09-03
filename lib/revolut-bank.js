// Revolut Business API client. OAuth 2.0 with JWT client_assertion signed
// by our RSA private key (paired with the X509 cert uploaded to Revolut).
//
// Required env vars in Vercel:
//   REVOLUT_CLIENT_ID       — from the Revolut app confirmation screen
//   REVOLUT_PRIVATE_KEY     — full contents of private.pem (BEGIN/END lines
//                              included; Vercel accepts multi-line env vars)
//   REVOLUT_REDIRECT_URI    — https://purhaven-erp.vercel.app/api/admin/revolut-callback
//   REVOLUT_MODE            — 'production' (default) or 'sandbox'
//
// Access tokens live 40 minutes, refresh tokens 90 days. getAccessToken()
// auto-refreshes.

import crypto from 'crypto';
import { sql } from './db.js';

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is not set`);
  return v;
}

export function isConfigured() {
  return !!(
    process.env.REVOLUT_CLIENT_ID &&
    process.env.REVOLUT_PRIVATE_KEY &&
    process.env.REVOLUT_REDIRECT_URI
  );
}

function apiHost() {
  return process.env.REVOLUT_MODE === 'sandbox'
    ? 'https://sandbox-b2b.revolut.com'
    : 'https://b2b.revolut.com';
}

function authorizeHost() {
  return process.env.REVOLUT_MODE === 'sandbox'
    ? 'https://sandbox-business.revolut.com'
    : 'https://business.revolut.com';
}

// ---------- OAuth ----------

export function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: envOrThrow('REVOLUT_CLIENT_ID'),
    response_type: 'code',
    scope: 'READ',
    redirect_uri: envOrThrow('REVOLUT_REDIRECT_URI'),
    state
  });
  return `${authorizeHost()}/app-confirm?${params.toString()}`;
}

/** Build the JWT client assertion Revolut wants in the token request body.
 *  Signed with our private RSA key; Revolut verifies with the X509 public
 *  cert we uploaded during app setup. */
function buildClientAssertion() {
  const clientId = envOrThrow('REVOLUT_CLIENT_ID');
  const privateKey = envOrThrow('REVOLUT_PRIVATE_KEY');
  const redirectUri = envOrThrow('REVOLUT_REDIRECT_URI');

  const iss = new URL(redirectUri).hostname; // e.g. 'purhaven-erp.vercel.app'
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss,
    sub: clientId,
    aud: 'https://revolut.com',
    exp: Math.floor(Date.now() / 1000) + 60 * 60 // 1 hour
  };

  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${b64(header)}.${b64(payload)}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64url');

  return `${signingInput}.${signature}`;
}

async function requestTokens(body) {
  const r = await fetch(`${apiHost()}/api/1.0/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error('Revolut token request failed: ' + (data.error_description || data.error || JSON.stringify(data)));
  }
  return data;
}

/** Exchange the auth code (first-time connect) for tokens. */
export async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: envOrThrow('REVOLUT_CLIENT_ID'),
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: buildClientAssertion()
  });
  return requestTokens(body);
}

/** Refresh an expired access token. */
async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: envOrThrow('REVOLUT_CLIENT_ID'),
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: buildClientAssertion()
  });
  return requestTokens(body);
}

// ---------- Token store ----------

export async function saveTokens({ tokens, userId }) {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  await sql`
    INSERT INTO erp_revolut_tokens (
      id, access_token, refresh_token, expires_at, scope, connected_by, connected_at, updated_at
    ) VALUES (
      1, ${tokens.access_token}, ${tokens.refresh_token}, ${expiresAt.toISOString()},
      ${tokens.scope || null}, ${userId || null}, NOW(), NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      expires_at = EXCLUDED.expires_at,
      scope = COALESCE(EXCLUDED.scope, erp_revolut_tokens.scope),
      updated_at = NOW()
  `;
}

export async function getStoredTokens() {
  const rows = await sql`SELECT * FROM erp_revolut_tokens WHERE id = 1`;
  return rows[0] || null;
}

/** Returns a valid access token, refreshing if it's within 60s of expiry. */
export async function getAccessToken() {
  const row = await getStoredTokens();
  if (!row) throw new Error('Revolut is not connected — visit /api/admin/revolut-connect to authorise.');

  if (new Date(row.expires_at).getTime() - Date.now() < 60_000) {
    const fresh = await refreshAccessToken(row.refresh_token);
    const expiresAt = new Date(Date.now() + fresh.expires_in * 1000);
    await sql`
      UPDATE erp_revolut_tokens SET
        access_token = ${fresh.access_token},
        refresh_token = ${fresh.refresh_token || row.refresh_token},
        expires_at = ${expiresAt.toISOString()},
        updated_at = NOW()
      WHERE id = 1
    `;
    return fresh.access_token;
  }
  return row.access_token;
}

// ---------- API calls ----------

async function revolutFetch(path) {
  const token = await getAccessToken();
  const r = await fetch(`${apiHost()}${path}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error(`Revolut API ${r.status} ${path}: ${data?.message || JSON.stringify(data)}`);
  }
  return data;
}

/** GET /accounts — list all bank accounts the connected Revolut user owns. */
export async function listAccounts() {
  return revolutFetch('/api/1.0/accounts');
}

/** GET /transactions — transactions within a date range. Defaults to last 30d. */
export async function listTransactions({ fromIso, toIso, count = 200 } = {}) {
  const from = fromIso || new Date(Date.now() - 30 * 864e5).toISOString();
  const to = toIso || new Date().toISOString();
  const params = new URLSearchParams({ from, to, count: String(count) });
  return revolutFetch(`/api/1.0/transactions?${params}`);
}

// ---------- Sync + matching ----------

/** Pull transactions from Revolut, upsert into erp_bank_transactions,
 *  auto-match against sales orders (inflows) or expenses (outflows).
 *  Returns a summary the UI can display. */
export async function syncTransactions({ days = 30, userId } = {}) {
  const fromIso = new Date(Date.now() - days * 864e5).toISOString();
  const toIso = new Date().toISOString();
  const txns = await listTransactions({ fromIso, toIso });

  // Map Revolut accounts → our bank_account rows (matched by revolut_account_id)
  const bankRows = await sql`SELECT id, revolut_account_id, currency FROM erp_bank_accounts WHERE revolut_account_id IS NOT NULL`;
  const bankByRevolutId = {};
  for (const b of bankRows) bankByRevolutId[b.revolut_account_id] = b;

  let inserted = 0, skipped = 0, matched = 0, unmatched = 0, unknownAccount = 0;

  for (const t of txns) {
    if (t.state !== 'completed') continue;
    for (const leg of (t.legs || [])) {
      const bank = bankByRevolutId[leg.account_id];
      if (!bank) { unknownAccount++; continue; }
      const amountPence = Math.round(Number(leg.amount) * 100);
      const txnDate = (t.completed_at || t.created_at || '').slice(0, 10);
      const description = leg.description || t.reference || t.type || '';
      const legId = `${t.id}:${leg.leg_id || leg.account_id}`;

      // Skip if we already have this exact leg
      const existing = await sql`SELECT id FROM erp_bank_transactions WHERE source_txn_id = ${legId} LIMIT 1`;
      if (existing.length > 0) { skipped++; continue; }

      // Auto-match
      let matchedSo = null, matchedExpense = null;
      if (amountPence > 0) {
        // Inflow → look for an SO with same total (±£0.50) in the last 14 days
        const soRows = await sql`
          SELECT id FROM erp_sales_orders
          WHERE status NOT IN ('draft','cancelled')
            AND ABS(total_pence - ${amountPence}) <= 50
            AND order_date BETWEEN (${txnDate}::date - INTERVAL '14 days') AND (${txnDate}::date + INTERVAL '3 days')
          ORDER BY order_date DESC
          LIMIT 1
        `;
        if (soRows[0]) matchedSo = soRows[0].id;
      } else {
        // Outflow → look for an existing expense with same absolute amount (±£0.50) within ±3 days
        const expRows = await sql`
          SELECT id FROM erp_expenses
          WHERE ABS(amount_pence - ${-amountPence}) <= 50
            AND expense_date BETWEEN (${txnDate}::date - INTERVAL '3 days') AND (${txnDate}::date + INTERVAL '3 days')
          ORDER BY expense_date DESC
          LIMIT 1
        `;
        if (expRows[0]) matchedExpense = expRows[0].id;
      }

      await sql`
        INSERT INTO erp_bank_transactions (
          bank_account_id, txn_date, amount_pence, description, reference,
          matched_so_id, matched_expense_id, imported_from, source_txn_id
        ) VALUES (
          ${bank.id}, ${txnDate}, ${amountPence}, ${description}, ${t.reference || null},
          ${matchedSo}, ${matchedExpense}, 'revolut', ${legId}
        )
        ON CONFLICT (source_txn_id) DO NOTHING
      `;
      inserted++;
      if (matchedSo || matchedExpense) matched++; else unmatched++;
    }
  }

  await sql`UPDATE erp_revolut_tokens SET last_sync_at = NOW() WHERE id = 1`;
  return { inserted, skipped, matched, unmatched, unknown_account: unknownAccount, transactions_seen: txns.length };
}
