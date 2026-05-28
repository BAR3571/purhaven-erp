import { requireUser } from '../../lib/session.js';
import { isConfigured, getAccessToken, ensureFolder, getStorageMode } from '../../lib/onedrive.js';

// Admin diagnostic: tests the archive-storage connection without uploading anything.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isConfigured()) {
    const missing = [];
    ['MS_GRAPH_TENANT_ID', 'MS_GRAPH_CLIENT_ID', 'MS_GRAPH_CLIENT_SECRET'].forEach(k => {
      if (!process.env[k]) missing.push(k);
    });
    if (!process.env.SHAREPOINT_HOSTNAME && !process.env.ONEDRIVE_USER_UPN) {
      missing.push('SHAREPOINT_HOSTNAME or ONEDRIVE_USER_UPN');
    }
    return res.status(400).json({
      ok: false, configured: false, missing,
      error: 'Archive storage env vars are not all set.'
    });
  }

  const mode = getStorageMode();
  try {
    const token = await getAccessToken();
    // Probe the three top-level folders we'll actually use
    const folders = {};
    for (const f of ['Picking Lists', 'Delivery Notes', 'Invoices']) {
      folders[f] = await ensureFolder(f).then(x => ({ id: x.id, webUrl: x.webUrl, path: x.fullPath }));
    }
    return res.status(200).json({
      ok: true,
      configured: true,
      storage_mode: mode,
      token_acquired: !!token,
      sharepoint_hostname: process.env.SHAREPOINT_HOSTNAME || null,
      sharepoint_site_path: process.env.SHAREPOINT_SITE_PATH || null,
      sharepoint_library: process.env.SHAREPOINT_LIBRARY || null,
      user_upn: process.env.ONEDRIVE_USER_UPN || null,
      folders
    });
  } catch (err) {
    return res.status(500).json({ ok: false, configured: true, storage_mode: mode, error: err.message });
  }
}
