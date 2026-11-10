import express from 'express';
import { listPending, transition, REVIEW_STATES } from '../lib/review/store.js';

export const reviewRouter = express.Router();

/**
 * F8 最小闭环：待复习卡点列表。
 * 走独立 mysql2 连接池（server/lib/seekdb/sql.js），不占检索那条串行队列 —— 关系表没有
 * SDK hybridSearch 的 @search_parm 会话变量问题，多人同时刷列表不该互相等。
 */
reviewRouter.get('/', async (req, res) => {
  const dataset = String(req.query.dataset ?? '').trim();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
  try {
    res.json(await listPending({ dataset: dataset || undefined, limit }));
  } catch (err) {
    res.status(503).json({ error: err.message, stage: 'review' });
  }
});

/**
 * 状态流转。合法性判定不在这里做，交给那条 UPDATE 的 WHERE 守卫：
 * affectedRows=0 就是"你没改成"，返回 409 并把当前状态和允许的去向一起回给前端。
 */
reviewRouter.post('/:id/state', async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  const target = String(req.body?.status ?? '').trim();
  if (!id) return res.status(400).json({ error: 'id 必填' });
  if (!REVIEW_STATES.includes(target)) {
    return res.status(400).json({ error: `status 只支持 ${REVIEW_STATES.join('/')}`, got: target });
  }

  try {
    const r = await transition(id, target);
    if (r.ok) return res.json({ ok: true, id: r.id, row: r.row });
    if (r.reason === 'not_found') return res.status(404).json({ error: `卡点 ${id} 不存在`, id });
    return res
      .status(409)
      .json({ error: `状态已从 ${r.from} 变化，${r.from} → ${target} 不是允许的流转`, id, from: r.from, to: target, allowed: r.allowed });
  } catch (err) {
    res.status(500).json({ error: err.message, stage: 'review:state' });
  }
});
