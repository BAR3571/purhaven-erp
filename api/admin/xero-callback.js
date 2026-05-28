import { requireUser } from '../../lib/session.js';
import { exchangeCodeForTokens, getConnectedTenants, saveTokens } from '../../lib/xero.js';

// GET /api/admin/xero-callback?code=...&state=...
// Receives the OAuth code from Xero, swaps it for tokens, picks the first
// connected tenant, and saves everything to erp_xero_tokens.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Xero auth error: ${error}`);
  if (!code) return res.status(400).send('Missing ?code from Xero');

  // Verify the state we set in /xero-connect to defend against CSRF
  const cookieState = (req.headers.cookie || '')
    .split(';').map(s => s.trim())
    .find(c => c.startsWith('xero_oauth_state='))?.split('=')[1];
  if (!cookieState || cookieState !== state) {
    return res.status(400).send('OAuth state mismatch — start over from /api/admin/xero-connect');
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const tenants = await getConnectedTenants(tokens.access_token);
    if (!tenants.length) return res.status(400).send('No Xero tenants returned — connect at least one organisation.');

    const t = tenants[0];
    await saveTokens({
      tokens,
      tenantId: t.tenantId,
      tenantName: t.tenantName,
      userId: user.id
    });

    // Clear the state cookie
    res.setHeader('Set-Cookie', 'xero_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');

    // Friendly success page
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(`
      <html><body style="font-family: system-ui; max-width: 640px; margin: 60px auto; padding: 0 20px;">
        <h2 style="color: #2f8f5e;">✓ Xero connected</h2>
        <p>The ERP is now linked to <strong>${escapeHtml(t.tenantName || 'your Xero organisation')}</strong>.</p>
        <p>Connected tenants: ${tenants.length === 1 ? '1' : tenants.length + ' (using the first — ' + escapeHtml(t.tenantName) + ')'}.</p>
        <p><a href="/">← Back to the ERP</a></p>
      </body></html>
    `);
  } catch (err) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(`
      <html><body style="font-family: system-ui; max-width: 640px; margin: 60px auto; padding: 0 20px;">
        <h2 style="color: #b32a2a;">Xero connect failed</h2>
        <pre style="background: #fde7e7; padding: 12px; border-radius: 6px;">${escapeHtml(err.message)}</pre>
        <p><a href="/api/admin/xero-connect">Try again</a></p>
      </body></html>
    `);
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
