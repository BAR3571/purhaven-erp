import crypto from 'crypto';
import { requireUser } from '../../lib/session.js';
import { buildAuthorizeUrl, isConfigured } from '../../lib/revolut-bank.js';

// GET /api/admin/revolut-connect
// Kicks off the OAuth flow: redirects to Revolut's consent screen. On approval
// Revolut calls /api/admin/revolut-callback with an auth code.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!isConfigured()) {
    return res.status(400).json({
      error: 'Revolut is not configured — set REVOLUT_CLIENT_ID, REVOLUT_PRIVATE_KEY and REVOLUT_REDIRECT_URI in Vercel.'
    });
  }

  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `revolut_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  res.setHeader('Location', buildAuthorizeUrl(state));
  return res.status(302).end();
}
