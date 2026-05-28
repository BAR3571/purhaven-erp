import { requireUser } from '../../lib/session.js';
import { isConfigured, getStoredTokens, getAccessToken } from '../../lib/xero.js';

// GET /api/admin/xero-status — diagnostic: confirms env vars + connection.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isConfigured()) {
    return res.status(400).json({
      ok: false,
      configured: false,
      missing: ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_REDIRECT_URI'].filter(k => !process.env[k]),
      error: 'Xero env vars are not all set.'
    });
  }

  const row = await getStoredTokens();
  if (!row) {
    return res.status(200).json({
      ok: false,
      configured: true,
      connected: false,
      connect_url: '/api/admin/xero-connect',
      message: 'Configured but no tokens stored yet. Visit /api/admin/xero-connect to authorise.'
    });
  }

  try {
    const { tenantId } = await getAccessToken(); // forces a refresh if expired
    return res.status(200).json({
      ok: true,
      configured: true,
      connected: true,
      tenant_id: tenantId,
      tenant_name: row.tenant_name,
      connected_at: row.connected_at,
      expires_at: row.expires_at,
      scope: row.scope
    });
  } catch (err) {
    return res.status(500).json({ ok: false, configured: true, connected: false, error: err.message });
  }
}
