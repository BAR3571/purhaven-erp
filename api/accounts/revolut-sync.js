import { requireUser } from '../../lib/session.js';
import { syncTransactions, isConfigured, getStoredTokens } from '../../lib/revolut-bank.js';

// POST /api/accounts/revolut-sync[?days=30]
// Pulls the last N days of Revolut transactions, upserts into
// erp_bank_transactions, auto-matches to sales orders / expenses.
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!isConfigured()) {
    return res.status(400).json({ error: 'Revolut is not configured — set REVOLUT_CLIENT_ID/PRIVATE_KEY/REDIRECT_URI in Vercel.' });
  }
  if (!(await getStoredTokens())) {
    return res.status(400).json({ error: 'Revolut is not connected — visit /api/admin/revolut-connect first.' });
  }

  const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 30));
  try {
    const result = await syncTransactions({ days, userId: user.id });
    return res.status(200).json({ ok: true, days, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
