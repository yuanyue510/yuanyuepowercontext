import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const cfg = {
  port: Number(process.env.PORT || 8787),
  host: process.env.SEEKDB_HOST || '127.0.0.1',
  port_db: Number(process.env.SEEKDB_PORT || 2881),
  user: process.env.SEEKDB_USER || 'root',
  password: process.env.SEEKDB_PASSWORD || '',
  database: process.env.SEEKDB_DATABASE || 'kb',
  path: process.env.SEEKDB_PATH || null
};

const store = new Store({
  path: cfg.path,
  host: cfg.host,
  port: cfg.port_db,
  user: cfg.user,
  password: cfg.password,
  database: cfg.database
});

const app = express();
app.use(express.json({ limit: '64mb' }));
// 开启跨源隔离：让 onnxruntime-web 的 WASM 后端能用多线程（SharedArrayBuffer）
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});

const isConnLost = (e) => /closed state|PROTOCOL_CONNECTION_LOST|Connection lost|ECONNRESET|ETIMEDOUT/i.test(e.message || '');

/** 连接被 seekdb 回收后自动重连并重试一次 */
const withConnRetry = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    if (!isConnLost(e)) throw e;
    console.warn('[seekdb] 连接已断开，重连后重试：', e.message);
    await store.reconnect();
    return await fn();
  }
};

const wrap = (fn) => (req, res) => {
  const t0 = performance.now();
  withConnRetry(() => fn(req, res))
    .then((out) => {
      const serverMs = performance.now() - t0;
      if (out && typeof out === 'object' && !res.headersSent) res.json({ ok: true, serverMs, ...out });
    })
    .catch((err) => {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'DIM_MISMATCH' ? 409 : 500;
      console.error(`[api] ${req.method} ${req.originalUrl} -> ${err.message}`);
      if (!res.headersSent) res.status(status).json({ ok: false, error: err.message, code: err.code || 'ERROR' });
    });
};

app.get('/api/health', wrap(async () => ({
  seekdb: {
    mode: store.mode,
    version: store.info.version,
    database: store.info.database,
    target: store.mode === 'embedded' ? cfg.path : `${cfg.host}:${cfg.port_db}`
  },
  node: process.version
})));

app.get('/api/collections', wrap(async () => ({ collections: await store.listCollections() })));

app.post('/api/collections', wrap(async (req) => {
  const { name, dimension } = req.body || {};
  if (!name || !/^[a-zA-Z0-9_-]{1,32}$/.test(name)) throw Object.assign(new Error('集合名需为 1-32 位字母/数字/下划线/短横线'), { code: 'BAD_NAME' });
  if (!dimension) throw Object.assign(new Error('缺少 dimension'), { code: 'BAD_REQUEST' });
  const created = await store.createCollection(name, Number(dimension));
  return { collection: created };
}));

app.delete('/api/collections/:name', wrap(async (req) => {
  await store.dropCollection(req.params.name);
  return { deleted: req.params.name };
}));

app.get('/api/collections/:name/stats', wrap(async (req) => ({ stats: await store.stats(req.params.name) })));

app.post('/api/collections/:name/refresh', wrap(async (req) => {
  const ms = await store.refresh(req.params.name);
  return { refreshMs: ms };
}));

/* 增量写入：一批 chunk（向量已在浏览器算好） */
app.post('/api/collections/:name/docs', wrap(async (req) => {
  const { items, refresh = true } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) throw Object.assign(new Error('items 为空'), { code: 'BAD_REQUEST' });
  const writeMs = await store.addDocuments(req.params.name, items);
  let refreshMs = 0;
  if (refresh) refreshMs = await store.refresh(req.params.name);
  const stats = await store.stats(req.params.name);
  return { inserted: items.length, writeMs, refreshMs, count: stats.count };
}));

/* 检索：向量、全文、混合，全部由 seekdb 执行 */
app.post('/api/collections/:name/search', wrap(async (req) => {
  const { mode = 'hybrid', queryText, embedding, k = 10, rankWindowSize = 40, rankConstant = 60 } = req.body || {};
  if (!queryText) throw Object.assign(new Error('缺少 queryText'), { code: 'BAD_REQUEST' });
  if (mode !== 'fulltext' && !Array.isArray(embedding)) throw Object.assign(new Error('缺少 embedding'), { code: 'BAD_REQUEST' });
  const out = await store.search(req.params.name, {
    mode,
    queryText,
    embedding,
    k: Number(k),
    rankWindowSize: Number(rankWindowSize),
    rankConstant: Number(rankConstant)
  });
  return { result: out };
}));

/* 原始 SQL 通道，仅用于「数据面板」里展示 seekdb 内部结构（只读） */
app.get('/api/collections/:name/peek', wrap(async (req) => {
  const limit = Math.min(Number(req.query.limit || 10), 50);
  const col = await store.collection(req.params.name);
  const r = await col.peek(limit);
  return {
    items: (r.ids || []).map((id, i) => ({
      id,
      text: (r.documents?.[i] || '').slice(0, 200),
      metadata: r.metadatas?.[i] || {}
    }))
  };
}));

/* ---------------- static ---------------- */
const PUB = path.join(ROOT, 'public');
const DIST = path.join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist');
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use('/vendor', express.static(DIST, { maxAge: '1h' }));
app.use(express.static(PUB, { extensions: ['html'], setHeaders: (res, p) => {
  if (p.endsWith('.onnx')) res.setHeader('Content-Type', 'application/octet-stream');
  if (p.endsWith('.json')) res.setHeader('Cache-Control', 'no-cache');
} }));

app.get('/api/meta', (req, res) => res.json({
  ok: true,
  model: { id: 'Xenova/bge-small-zh-v1.5', base: 'BAAI/bge-small-zh-v1.5', dimension: 512, source: 'https://huggingface.co/BAAI/bge-small-zh-v1.5' }
}));

const srv = app.listen(cfg.port, async () => {
  console.log(`[http] http://localhost:${cfg.port}`);
  try {
    await store.connect();
    console.log(`[seekdb] ${store.mode} mode ok, ${store.info.version} db=${store.info.database}`);
  } catch (e) {
    console.error('[seekdb] 连接失败:', e.message);
    console.error('        请先启动 seekdb：docker run -d -p 2881:2881 oceanbase/seekdb');
  }
});

process.on('SIGINT', async () => {
  await store.close();
  srv.close(() => process.exit(0));
});
