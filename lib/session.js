import { randomBytes } from 'node:crypto';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import { sql } from './db.js';

const COOKIE_NAME = 'perp_session';
const SESSION_DAYS = 30;

export function generateToken() {
  return randomBytes(32).toString('hex');
}

export function readSessionToken(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const parsed = parseCookie(raw);
  return parsed[COOKIE_NAME] || null;
}

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60
  }));
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0
  }));
}

export async function createSession(userId, req) {
  const token = generateToken();
  const userAgent = (req.headers['user-agent'] || '').slice(0, 500);
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await sql`
    INSERT INTO erp_sessions (token, user_id, expires_at, user_agent, ip)
    VALUES (${token}, ${userId}, ${expiresAt}, ${userAgent}, ${ip})
  `;
  return token;
}

export async function getSessionUser(token) {
  if (!token) return null;
  const rows = await sql`
    SELECT u.id, u.email, u.name, u.role, s.expires_at
    FROM erp_sessions s
    JOIN erp_users u ON u.id = s.user_id
    WHERE s.token = ${token} AND s.expires_at > NOW()
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function destroySession(token) {
  if (!token) return;
  await sql`DELETE FROM erp_sessions WHERE token = ${token}`;
}

export async function requireUser(req, res) {
  const token = readSessionToken(req);
  const user = await getSessionUser(token);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return user;
}
