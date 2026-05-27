import { requireUser } from '../../../lib/session.js';
import { adjustStock, getMainWarehouseId } from '../../../lib/stock.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const productId = parseInt(req.query.id, 10);
  if (!Number.isFinite(productId)) return res.status(400).json({ error: 'Invalid product id' });

  const b = req.body || {};
  let warehouseId = b.warehouse_id ? parseInt(b.warehouse_id, 10) : null;
  if (!warehouseId) warehouseId = await getMainWarehouseId();
  if (!warehouseId) return res.status(400).json({ error: 'No warehouse available' });

  const delta = parseInt(b.delta, 10);
  if (!Number.isFinite(delta) || delta === 0) {
    return res.status(400).json({ error: 'Non-zero delta required' });
  }

  try {
    const newQty = await adjustStock({
      productId,
      warehouseId,
      delta,
      movementType: 'adjustment',
      referenceType: 'manual',
      notes: (b.notes || '').trim() || null,
      userId: user.id
    });
    return res.status(200).json({ ok: true, qty_on_hand: newQty });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
