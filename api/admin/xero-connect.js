import { requireUser } from '../../lib/session.js';
import { buildAuthorizeUrl, isConfigured } from '../../lib/xero.js';
import crypto from 'crypto';

// GET /api/admin/xero-connect
// Redirects the admin user to Xero's consent screen. After they grant access,
// Xero calls /api/admin/xero-callback with the auth code.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!isConfigured()) {
    return res.status(400).json({
      error: 'Xero is not configured — set XERO_CLIENT_ID, XERO_CLIENT_SECRET and XERO_REDIRECT_URI in Vercel.'
    });
  }

  const state = crypto.randomBytes(16).toString('hex');
  // Stash the state in a short-lived cookie so the callback can verify it
  res.setHeader('Set-Cookie', `xero_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  res.setHeader('Location', buildAuthorizeUrl(state));
  return res.status(302).end();
}
