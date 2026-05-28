import { requireUser } from '../../lib/session.js';
import { isConfigured, getAccessToken } from '../../lib/onedrive.js';

// Lists users + their OneDrive availability in the connected Entra tenant.
// Diagnostic only — helps figure out which UPN to use in ONEDRIVE_USER_UPN.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!isConfigured()) return res.status(400).json({ error: 'Graph env vars not set' });

  try {
    const token = await getAccessToken();
    const r = await fetch('https://graph.microsoft.com/v1.0/users?$select=id,displayName,userPrincipalName,mail,assignedLicenses', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || 'list failed', detail: data });
    // For each user, also probe whether they have a drive
    const users = await Promise.all((data.value || []).map(async (u) => {
      try {
        const dr = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(u.userPrincipalName)}/drive?$select=id,webUrl,name`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const dd = await dr.json();
        return {
          displayName: u.displayName,
          userPrincipalName: u.userPrincipalName,
          mail: u.mail,
          licenseCount: (u.assignedLicenses || []).length,
          drive_ok: dr.ok,
          drive_error: dr.ok ? null : (dd?.error?.code || dd?.error?.message || 'unknown'),
          drive_webUrl: dr.ok ? dd.webUrl : null
        };
      } catch (e) {
        return { userPrincipalName: u.userPrincipalName, drive_ok: false, drive_error: e.message };
      }
    }));
    return res.status(200).json({ ok: true, users });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
