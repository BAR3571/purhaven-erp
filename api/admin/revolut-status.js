import { requireUser } from '../../lib/session.js';
import { isConfigured, getStoredTokens, getAccessToken, listAccounts } from '../../lib/revolut-bank.js';

// GET /api/admin/revolut-status — diagnostic.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isConfigured()) {
    return res.status(400).json({
      ok: false, configured: false,
      missing: ['REVOLUT_CLIENT_ID', 'REVOLUT_PRIVATE_KEY', 'REVOLUT_REDIRECT_URI'].filter(k => !process.env[k]),
      error: 'Revolut env vars are not all set.'
    });
  }

  const row = await getStoredTokens();
  if (!row) {
    return res.status(200).json({
      ok: false, configured: true, connected: false,
      connect_url: '/api/admin/revolut-connect',
      message: 'Configured but no tokens stored yet. Visit /api/admin/revolut-connect to authorise.'
    });
  }

  try {
    await getAccessToken(); // forces a refresh if expired
    const accounts = await listAccounts();
    return res.status(200).json({
      ok: true, configured: true, connected: true,
      mode: process.env.REVOLUT_MODE || 'production',
      connected_at: row.connected_at,
      expires_at: row.expires_at,
      last_sync_at: row.last_sync_at,
      revolut_accounts: accounts.map(a => ({
        id: a.id, name: a.name, currency: a.currency, state: a.state
      }))
    });
  } catch (err) {
    return res.status(500).json({ ok: false, configured: true, connected: false, error: err.message });
  }
}
