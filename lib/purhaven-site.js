import { neon } from '@neondatabase/serverless';

let _client = null;

/**
 * Returns a Neon client pointing at the purhaven website's database.
 * Throws if PURHAVEN_DATABASE_URL is not set — the website-import endpoint
 * surfaces this as a 400 with a useful message.
 */
export function getPurHavenSiteSql() {
  if (!process.env.PURHAVEN_DATABASE_URL) {
    throw new Error(
      'PURHAVEN_DATABASE_URL is not set. Add it in Vercel project Settings → Environment Variables. ' +
      'Copy the DATABASE_URL value from the purhaven (website) Vercel project.'
    );
  }
  if (!_client) _client = neon(process.env.PURHAVEN_DATABASE_URL);
  return _client;
}
