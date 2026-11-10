import express from 'express';
import { config } from '../config.js';
import { exclusive } from '../lib/seekdb/client.js';
import { findDataset } from '../lib/seekdb/collections.js';
import { answerQuery } from '../lib/answer/assemble.js';
import { registryState } from './dataset.js';

export const searchRouter = express.Router();

searchRouter.post('/', async (req, res) => {
  const ds = await registryState();
  if (!ds.ready) return res.status(503).json({ error: 'seekdb 注册表不可用（详见 /api/dataset/list 的报错）', cause: ds.error });
  const datasetName = String(req.body?.datasetName ?? '').trim();
  const query = String(req.body?.query ?? '').trim();
  const nResults = Math.min(32, Math.max(1, Number(req.body?.nResults ?? config.collection.defaultNResults)));

  if (!datasetName) return res.status(400).json({ error: 'datasetName 必填（单资料集检索，默认口径最严）' });
  if (!query) return res.status(400).json({ error: 'query 必填' });

  try {
    const row = await exclusive(() => findDataset(datasetName));
    if (!row) return res.status(404).json({ error: `资料集「${datasetName}」不存在，请先导入` });
    if (row.status !== 'ready') return res.status(409).json({ error: `资料集状态为 ${row.status}，未过就绪门槛前进检索` });

    const result = await exclusive(() => answerQuery({ datasetName, collectionName: row.collection_name, query, nResults }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, stage: 'search' });
  }
});
