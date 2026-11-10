import express from 'express';
import { exclusive } from '../lib/seekdb/client.js';
import { listStuck } from '../lib/stuck/ledger.js';

export const stuckRouter = express.Router();

/** P5 最小项：证明"未覆盖 → 落卡点"这条链真的写进了 seekdb（不是内存里的假数据）。 */
stuckRouter.get('/', async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
  try {
    res.json(await exclusive(() => listStuck(limit)));
  } catch (err) {
    res.status(503).json({ error: err.message, stage: 'stuck' });
  }
});
