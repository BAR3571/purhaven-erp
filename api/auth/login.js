import bcrypt from 'bcryptjs';
import { sql } from '../../lib/db.js';
import { createSession, setSessionCookie } from '../../lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const rows = await sql`
    SELECT id, email, name, role, password_hash, active FROM erp_users
    WHERE email = ${email.toLowerCase()} LIMIT 1
  `;

  if (rows.length === 0) {
    await bcrypt.compare(password, '$2a$12$dummyhashthatwillneverevermatchanythinguseful12345');
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const user = rows[0];
  if (!user.active) return res.status(403).json({ error: 'Account deactivated' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  await sql`UPDATE erp_users SET last_login_at = NOW() WHERE id = ${user.id}`;

  const token = await createSession(user.id, req);
  setSessionCookie(res, token);

  return res.status(200).json({ ok: true, email: user.email, name: user.name, role: user.role });
}
