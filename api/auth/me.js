import { readSessionToken, getSessionUser } from '../../lib/session.js';

export default async function handler(req, res) {
  const token = readSessionToken(req);
  const user = await getSessionUser(token);
  if (!user) return res.status(401).json({ ok: false });
  return res.status(200).json({ ok: true, email: user.email, name: user.name, role: user.role });
}
