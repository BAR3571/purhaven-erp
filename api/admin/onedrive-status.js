import { requireUser } from '../../lib/session.js';
import { isConfigured, getAccessToken, ensureFolder } from '../../lib/onedrive.js';

// Admin diagnostic: tests the OneDrive connection without uploading anything.
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
      missing: ['MS_GRAPH_TENANT_ID', 'MS_GRAPH_CLIENT_ID', 'MS_GRAPH_CLIENT_SECRET', 'ONEDRIVE_USER_UPN']
        .filter(k => !process.env[k]),
      error: 'OneDrive env vars are not all set. See README for setup.'
    });
  }

  try {
    const token = await getAccessToken();
    const folder = await ensureFolder('Despatches');
    return res.status(200).json({
      ok: true,
      configured: true,
      token_acquired: !!token,
      root_folder: process.env.ONEDRIVE_ROOT_FOLDER || 'PurHaven ERP',
      user_upn: process.env.ONEDRIVE_USER_UPN,
      despatches_folder: { id: folder.id, webUrl: folder.webUrl, path: folder.fullPath }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, configured: true, error: err.message });
  }
}
