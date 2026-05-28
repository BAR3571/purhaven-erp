// Microsoft Graph client for archiving generated PDFs into OneDrive (or a
// SharePoint document library) — uses the client-credentials flow so no per-user
// OAuth dance is needed.
//
// Required env vars (set in Vercel):
//   MS_GRAPH_TENANT_ID       — Entra tenant ID (looks like a GUID)
//   MS_GRAPH_CLIENT_ID       — App registration client ID
//   MS_GRAPH_CLIENT_SECRET   — App registration client secret value
//   ONEDRIVE_USER_UPN        — email/UPN of the user whose drive we upload to
//                              (e.g. sales@uvcvtm.com). The Entra app needs
//                              Files.ReadWrite.All Application permission with
//                              admin consent.
//   ONEDRIVE_ROOT_FOLDER     — optional, defaults to 'PurHaven ERP'. All docs
//                              live under this folder in the target OneDrive.

let _tokenCache = null;

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is not set`);
  return v;
}

export function isConfigured() {
  return !!(
    process.env.MS_GRAPH_TENANT_ID &&
    process.env.MS_GRAPH_CLIENT_ID &&
    process.env.MS_GRAPH_CLIENT_SECRET &&
    process.env.ONEDRIVE_USER_UPN
  );
}

export async function getAccessToken() {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60_000) return _tokenCache.token;

  const tenant = envOrThrow('MS_GRAPH_TENANT_ID');
  const clientId = envOrThrow('MS_GRAPH_CLIENT_ID');
  const clientSecret = envOrThrow('MS_GRAPH_CLIENT_SECRET');

  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default'
    })
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error('MS Graph token fetch failed: ' + (data.error_description || data.error || r.status));
  }
  _tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000)
  };
  return _tokenCache.token;
}

function rootFolder() {
  return (process.env.ONEDRIVE_ROOT_FOLDER || 'PurHaven ERP').replace(/^\/+|\/+$/g, '');
}

function userDrivePrefix() {
  const upn = envOrThrow('ONEDRIVE_USER_UPN');
  return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(upn)}/drive`;
}

/** Upload a Buffer to OneDrive at `<root>/<folderPath>/<filename>` (simple PUT, suitable for files < 4 MB).
 *  Returns { id, name, webUrl, parentUrl, size }. Overwrites existing files at the same path. */
export async function uploadFile({ folderPath, filename, buffer, contentType = 'application/octet-stream' }) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const token = await getAccessToken();
  const fullPath = [rootFolder(), folderPath, filename]
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/');

  const url = `${userDrivePrefix()}/root:/${encodePath(fullPath)}:/content`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': contentType
    },
    body: buffer
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error('OneDrive upload failed (' + r.status + '): ' + (data?.error?.message || JSON.stringify(data)));
  }
  return {
    id: data.id,
    name: data.name,
    webUrl: data.webUrl,
    parentUrl: data.parentReference?.path,
    size: data.size,
    fullPath
  };
}

/** Fetch a folder's web URL (the link the user can click to open it in OneDrive).
 *  Creates the folder if it doesn't exist. */
export async function ensureFolder(folderPath) {
  const token = await getAccessToken();
  const fullPath = [rootFolder(), folderPath].filter(Boolean).join('/').replace(/\/+/g, '/');

  // Try GET first
  const getUrl = `${userDrivePrefix()}/root:/${encodePath(fullPath)}`;
  const getR = await fetch(getUrl, { headers: { 'Authorization': `Bearer ${token}` } });
  if (getR.ok) {
    const d = await getR.json();
    return { id: d.id, webUrl: d.webUrl, name: d.name, fullPath };
  }

  // Otherwise create it under its parent. Walk the path and create each segment.
  const segments = fullPath.split('/').filter(Boolean);
  let parentPath = '';
  let parentItem = null;
  for (const seg of segments) {
    const tryPath = parentPath ? `${parentPath}/${seg}` : seg;
    const checkUrl = `${userDrivePrefix()}/root:/${encodePath(tryPath)}`;
    const check = await fetch(checkUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    if (check.ok) {
      parentItem = await check.json();
    } else {
      // Create under parent
      const parentRefUrl = parentPath
        ? `${userDrivePrefix()}/root:/${encodePath(parentPath)}:/children`
        : `${userDrivePrefix()}/root/children`;
      const createR = await fetch(parentRefUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: seg, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' })
      });
      const createD = await createR.json();
      if (!createR.ok) {
        throw new Error('OneDrive create folder failed: ' + (createD?.error?.message || createR.status));
      }
      parentItem = createD;
    }
    parentPath = tryPath;
  }
  return { id: parentItem.id, webUrl: parentItem.webUrl, name: parentItem.name, fullPath };
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}
