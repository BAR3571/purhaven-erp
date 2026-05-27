import { requireUser } from '../../lib/session.js';
import { getGiWithRelations } from '../../lib/goods-in.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const gi = await getGiWithRelations(id);
  if (!gi) return res.status(404).json({ error: 'Goods In not found' });
  return res.status(200).json({ ok: true, goods_in: gi });
}
