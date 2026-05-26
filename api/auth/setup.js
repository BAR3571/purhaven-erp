import bcrypt from 'bcryptjs';
import { sql } from '../../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !process.env.MIGRATION_TOKEN || token !== process.env.MIGRATION_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized — Bearer token required' });
  }

  const { email, password, name, role } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (password.length < 10) return res.status(400).json({ error: 'password must be at least 10 characters' });

  const passwordHash = await bcrypt.hash(password, 12);
  const safeRole = ['user', 'admin', 'director'].includes(role) ? role : 'admin';

  const result = await sql`
    INSERT INTO erp_users (email, password_hash, name, role)
    VALUES (${email.toLowerCase()}, ${passwordHash}, ${name || null}, ${safeRole})
    ON CONFLICT (email) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          name = COALESCE(EXCLUDED.name, erp_users.name),
          role = EXCLUDED.role
    RETURNING id, email, role, (xmax = 0) AS created
  `;

  return res.status(200).json({
    ok: true,
    user_id: result[0].id,
    email: result[0].email,
    role: result[0].role,
    created: result[0].created
  });
}
