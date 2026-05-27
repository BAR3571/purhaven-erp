import { requireUser } from '../../lib/session.js';
import { getPurHavenSiteSql } from '../../lib/purhaven-site.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  let siteSql;
  try { siteSql = getPurHavenSiteSql(); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  try {
    const dbInfo = await siteSql`SELECT current_database() AS db, current_user AS usr, current_schema() AS schema`;
    const tables = await siteSql`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
    `;
    return res.status(200).json({
      ok: true,
      connected_to: dbInfo[0],
      tables
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
