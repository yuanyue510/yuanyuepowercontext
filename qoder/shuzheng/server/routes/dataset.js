import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { importDataset } from '../lib/ingest/pipeline.js';
import { exclusive } from '../lib/seekdb/client.js';
import { ensureRegistryTable, listRegistry, findDataset } from '../lib/seekdb/collections.js';

export const datasetRouter = express.Router();

let registryReady = false;
let registryError = null;

export async function initRegistry() {
  try {
    await ensureRegistryTable();
    registryReady = true;
    registryError = null;
    return { ok: true };
  } catch (err) {
    registryError = err.message;
    return { ok: false, error: err.message };
  }
}

/** seekdb 可能比 Node 后起来（虚拟机/容器），所以每次进来先自愈一次，不要求重启进程。 */
export async function registryState() {
  if (!registryReady) await initRegistry();
  return { ready: registryReady, error: registryError };
}

async function guard() {
  const st = await registryState();
  return st.ready ? null : { status: 503, body: { error: 'seekdb 注册表不可用，检索与导入已阻断（不静默降级）', cause: st.error } };
}

// 导入是 CPU（本地向量化）+ 库操作，且会重建集合，必须整体排队。
datasetRouter.post('/import', async (req, res) => {
  const block = await guard();
  if (block) return res.status(block.status).json(block.body);

  const datasetName = String(req.body?.datasetName ?? '').trim();
  const text = req.body?.text;
  const filename = String(req.body?.filename ?? '').trim() || 'pasted.txt';

  if (!datasetName) return res.status(400).json({ error: 'datasetName 必填（中文资料集名，UI 只看中文名）' });
  if (datasetName.length > 100) return res.status(400).json({ error: 'datasetName 过长（≤100 字）' });
  if (typeof text !== 'string' || text.trim().length < 20) {
    return res.status(400).json({ error: 'text 必填且不能为空（浏览器端把文件读成纯文本再提交，避免 multipart 依赖）' });
  }

  try {
    const stats = await exclusive(() => importDataset({ datasetName, filename, text }));
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message, stage: 'import' });
  }
});

datasetRouter.get('/list', async (_req, res) => {
  const block = await guard();
  if (block) return res.status(block.status).json(block.body);
  try {
    res.json({ datasets: await exclusive(listRegistry) });
  } catch (err) {
    res.status(500).json({ error: err.message, stage: 'list' });
  }
});

/** F2.1 / 证据卡跳原文：返回规范化全文，前端按 char_start–char_end 定位并高亮。 */
datasetRouter.get('/:name/text', async (req, res) => {
  const block = await guard();
  if (block) return res.status(block.status).json(block.body);
  try {
    const row = await exclusive(() => findDataset(req.params.name));
    if (!row) return res.status(404).json({ error: `资料集「${req.params.name}」不存在` });
    const file = path.join(config.paths.normalized, `${row.doc_id}.txt`);
    const text = await fs.readFile(file, 'utf8');
    res.json({
      datasetName: row.name,
      docId: row.doc_id,
      filename: row.filename,
      chunkCount: row.chunk_count,
      status: row.status,
      charCount: text.length,
      text,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stage: 'text' });
  }
});
