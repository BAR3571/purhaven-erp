import { readSessionToken, destroySession, clearSessionCookie } from '../../lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
  const token = readSessionToken(req);
  await destroySession(token);
  clearSessionCookie(res);
  return res.status(200).json({ ok: true });
}
