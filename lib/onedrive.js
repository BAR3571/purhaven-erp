// Microsoft Graph client for archiving generated PDFs into a SharePoint
// document library (preferred) or a user's OneDrive — uses the client-credentials
// flow so no per-user OAuth dance is needed.
//
// Required env vars (set in Vercel):
//   MS_GRAPH_TENANT_ID       — Entra tenant ID (looks like a GUID)
//   MS_GRAPH_CLIENT_ID       — App registration client ID
//   MS_GRAPH_CLIENT_SECRET   — App registration client secret value
//
// SharePoint mode (recommended — uploads to a site document library):
//   SHAREPOINT_HOSTNAME      — e.g. 'vtmukltd.sharepoint.com'
//   SHAREPOINT_SITE_PATH     — optional, e.g. 'sites/VTMUKLtd' (omit for root site)
//   SHAREPOINT_LIBRARY       — document library name, e.g. 'Purhaven - Documents'
//                              (if omitted, the site's default drive is used)
//   App needs Sites.ReadWrite.All Application permission + admin consent.
//
// OneDrive-for-Business mode (fallback — uploads to a user's drive):
//   ONEDRIVE_USER_UPN        — email/UPN of an M365 user (e.g. sales@example.com)
//   ONEDRIVE_ROOT_FOLDER     — optional, defaults to 'PurHaven ERP'. All docs
//                              live under this folder in the target drive.
//   App needs Files.ReadWrite.All Application permission + admin consent.
//
// If SHAREPOINT_HOSTNAME is set, SharePoint mode is used; otherwise OneDrive mode.

let _tokenCache = null;
let _driveCache = null;

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is not set`);
  return v;
}

function isSharePointMode() {
  return !!process.env.SHAREPOINT_HOSTNAME;
}

export function isConfigured() {
  if (!process.env.MS_GRAPH_TENANT_ID) return false;
  if (!process.env.MS_GRAPH_CLIENT_ID) return false;
  if (!process.env.MS_GRAPH_CLIENT_SECRET) return false;
  if (isSharePointMode()) return true;
  return !!process.env.ONEDRIVE_USER_UPN;
}

export function getStorageMode() {
  return isSharePointMode() ? 'sharepoint' : 'onedrive';
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
  if (isSharePointMode()) return ''; // SharePoint library has its own structure — no extra root folder
  return (process.env.ONEDRIVE_ROOT_FOLDER || 'PurHaven ERP').replace(/^\/+|\/+$/g, '');
}

/** Resolve the Graph drive prefix once and cache it. In SharePoint mode this is
 *  `/drives/{id}`; in OneDrive mode it is `/users/{upn}/drive`. */
async function drivePrefix() {
  if (!isSharePointMode()) {
    const upn = envOrThrow('ONEDRIVE_USER_UPN');
    return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(upn)}/drive`;
  }
  if (_driveCache) return _driveCache.prefix;

  const token = await getAccessToken();
  const hostname = envOrThrow('SHAREPOINT_HOSTNAME');
  const sitePath = (process.env.SHAREPOINT_SITE_PATH || '').replace(/^\/+|\/+$/g, '');
  const library = process.env.SHAREPOINT_LIBRARY;

  // Resolve site
  const siteUrl = sitePath
    ? `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(hostname)}:/${encodePath(sitePath)}`
    : `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(hostname)}`;
  const siteR = await fetch(siteUrl, { headers: { 'Authorization': `Bearer ${token}` } });
  const siteD = await siteR.json();
  if (!siteR.ok) {
    throw new Error('SharePoint site lookup failed: ' + (siteD?.error?.message || siteR.status));
  }
  const siteId = siteD.id;

  // Resolve drive (named library, or default drive)
  let driveId, driveWebUrl;
  if (library) {
    const drivesR = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/drives?$select=id,name,webUrl`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const drivesD = await drivesR.json();
    if (!drivesR.ok) {
      throw new Error('SharePoint drives list failed: ' + (drivesD?.error?.message || drivesR.status));
    }
    const found = (drivesD.value || []).find(d => d.name === library);
    if (!found) {
      const names = (drivesD.value || []).map(d => d.name).join(', ') || '(none)';
      throw new Error(`SharePoint library "${library}" not found on site. Available: ${names}`);
    }
    driveId = found.id;
    driveWebUrl = found.webUrl;
  } else {
    const dR = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/drive?$select=id,webUrl`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const dD = await dR.json();
    if (!dR.ok) {
      throw new Error('SharePoint default drive lookup failed: ' + (dD?.error?.message || dR.status));
    }
    driveId = dD.id;
    driveWebUrl = dD.webUrl;
  }

  _driveCache = {
    prefix: `https://graph.microsoft.com/v1.0/drives/${driveId}`,
    driveId,
    driveWebUrl,
    siteId
  };
  return _driveCache.prefix;
}

/** Upload a Buffer at `<root>/<folderPath>/<filename>` (simple PUT, < 4 MB).
 *  Returns { id, name, webUrl, parentUrl, size, fullPath }. Overwrites on conflict. */
export async function uploadFile({ folderPath, filename, buffer, contentType = 'application/octet-stream' }) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const token = await getAccessToken();
  const prefix = await drivePrefix();
  const fullPath = [rootFolder(), folderPath, filename]
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/');

  const url = `${prefix}/root:/${encodePath(fullPath)}:/content`;
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
    throw new Error('Upload failed (' + r.status + '): ' + (data?.error?.message || JSON.stringify(data)));
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

/** Return a folder's web URL, creating it (and any missing parents) if needed. */
export async function ensureFolder(folderPath) {
  const token = await getAccessToken();
  const prefix = await drivePrefix();
  const fullPath = [rootFolder(), folderPath].filter(Boolean).join('/').replace(/\/+/g, '/');

  if (!fullPath) {
    // Caller asked for the drive root itself
    const rootR = await fetch(`${prefix}/root?$select=id,name,webUrl`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const rootD = await rootR.json();
    if (!rootR.ok) throw new Error('Drive root fetch failed: ' + (rootD?.error?.message || rootR.status));
    return { id: rootD.id, webUrl: rootD.webUrl, name: rootD.name, fullPath: '' };
  }

  // Fast path: try GET first
  const getUrl = `${prefix}/root:/${encodePath(fullPath)}`;
  const getR = await fetch(getUrl, { headers: { 'Authorization': `Bearer ${token}` } });
  if (getR.ok) {
    const d = await getR.json();
    return { id: d.id, webUrl: d.webUrl, name: d.name, fullPath };
  }

  // Walk path, creating missing segments
  const segments = fullPath.split('/').filter(Boolean);
  let parentPath = '';
  let parentItem = null;
  for (const seg of segments) {
    const tryPath = parentPath ? `${parentPath}/${seg}` : seg;
    const checkUrl = `${prefix}/root:/${encodePath(tryPath)}`;
    const check = await fetch(checkUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    if (check.ok) {
      parentItem = await check.json();
    } else {
      const parentRefUrl = parentPath
        ? `${prefix}/root:/${encodePath(parentPath)}:/children`
        : `${prefix}/root/children`;
      const createR = await fetch(parentRefUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: seg, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' })
      });
      const createD = await createR.json();
      if (!createR.ok) {
        throw new Error('Create folder failed: ' + (createD?.error?.message || createR.status));
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
