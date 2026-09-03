import { requireUser } from '../../lib/session.js';
import { exchangeCodeForTokens, saveTokens, listAccounts } from '../../lib/revolut-bank.js';
import { sql } from '../../lib/db.js';

// GET /api/admin/revolut-callback?code=...&state=...
// Called by Revolut after user consent. Swaps the code for tokens, fetches
// the list of Revolut accounts, and auto-links each to a matching row in
// erp_bank_accounts (creating them if none exist yet).
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const { code, state, error } = req.query;
  if (error) return sendPage(res, 400, `Revolut auth error: <code>${escapeHtml(error)}</code>`);
  if (!code) return sendPage(res, 400, 'Missing ?code from Revolut');

  const cookieState = (req.headers.cookie || '')
    .split(';').map(s => s.trim())
    .find(c => c.startsWith('revolut_oauth_state='))?.split('=')[1];
  if (!cookieState || cookieState !== state) {
    return sendPage(res, 400, 'OAuth state mismatch — start over from /api/admin/revolut-connect');
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    await saveTokens({ tokens, userId: user.id });

    // Fetch Revolut accounts and auto-link into erp_bank_accounts
    const revAccounts = await listAccounts();
    let linked = 0, created = 0;
    for (const acc of revAccounts) {
      const existing = await sql`SELECT id FROM erp_bank_accounts WHERE revolut_account_id = ${acc.id} LIMIT 1`;
      if (existing.length > 0) { linked++; continue; }

      // Look for an unlinked bank account whose name loosely matches the currency,
      // e.g. we may have already created "Revolut Business" manually
      const guess = await sql`
        SELECT id FROM erp_bank_accounts
        WHERE revolut_account_id IS NULL
          AND (currency = ${acc.currency} OR currency IS NULL)
          AND (LOWER(name) LIKE '%revolut%' OR LOWER(provider) LIKE '%revolut%')
        LIMIT 1
      `;
      if (guess[0]) {
        await sql`UPDATE erp_bank_accounts SET revolut_account_id = ${acc.id}, currency = ${acc.currency}, updated_at = NOW() WHERE id = ${guess[0].id}`;
        linked++;
      } else {
        const label = `Revolut · ${acc.name || acc.currency}`;
        await sql`
          INSERT INTO erp_bank_accounts (name, provider, currency, opening_balance_pence, revolut_account_id)
          VALUES (${label}, 'Revolut', ${acc.currency}, 0, ${acc.id})
        `;
        created++;
      }
    }

    res.setHeader('Set-Cookie', 'revolut_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    return sendPage(res, 200, `
      <h2 style="color:#2f8f5e;">✓ Revolut connected</h2>
      <p>Linked <strong>${linked}</strong> existing bank account${linked === 1 ? '' : 's'}${created > 0 ? `, created <strong>${created}</strong> new one${created === 1 ? '' : 's'}` : ''}.</p>
      <p>Next: go to <a href="/accounts">/accounts</a> and click <strong>Sync now</strong> to pull the last 30 days of transactions.</p>
    `);
  } catch (err) {
    return sendPage(res, 500, `<h2 style="color:#b32a2a;">Revolut connect failed</h2><pre style="background:#fde7e7;padding:12px;border-radius:6px;">${escapeHtml(err.message)}</pre><p><a href="/api/admin/revolut-connect">Try again</a></p>`);
  }
}

function sendPage(res, status, body) {
  res.setHeader('Content-Type', 'text/html');
  return res.status(status).send(`<html><body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px;">${body}</body></html>`);
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
