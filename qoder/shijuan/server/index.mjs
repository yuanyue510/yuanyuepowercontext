import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { CONFIG } from './config.mjs';
import { Db } from './db.mjs';
import { Embedder } from './embed.mjs';
import { chunkText, chunkId } from './chunk.mjs';
import { answerFromHits, conceptKey } from './qa.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.use(express.json({ limit: '24mb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

const db = new Db();
const embedder = new Embedder();
let bootError = null;

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, code, message, extra = {}) =>
  res.status(code === 'NOT_FOUND' ? 404 : 400).json({ ok: false, code, message, ...extra });

/* ------------------------------ 健康与概览 ------------------------------ */

app.get('/api/health', async (req, res) => {
  if (bootError) return fail(res, 'BOOT', bootError);
  const collections = await db.listCollections();
  ok(res, {
    seekdb: { version: db.version, database: CONFIG.seekdb.database },
    model: {
      name: CONFIG.embed.modelName,
      dtype: CONFIG.embed.dtype,
      dimension: CONFIG.embed.dimension,
      ready: embedder.ready,
      loadMs: embedder.loadMs
    },
    collections
  });
});

app.get('/api/overview', async (req, res) => {
  const learner = String(req.query.learner || 'demo');
  const collections = await db.listCollections();
  const memory = await db.memoryOverview(learner);
  ok(res, {
    collections,
    docs: collections.reduce((s, c) => s + c.count, 0),
    memory
  });
});

/* ------------------------------ 资料集 ------------------------------ */

app.get('/api/collections', async (req, res) => ok(res, { collections: await db.listCollections() }));

app.post('/api/collections', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!/^[\w\u4e00-\u9fa5-]{1,40}$/.test(name)) return fail(res, 'BAD_NAME', '资料集名只允许中英文、数字、下划线与连字符，最长 40');
  ok(res, await db.createCollection(name));
});

app.delete('/api/collections/:name', async (req, res) => {
  ok(res, await db.deleteCollection(req.params.name));
});

/* ------------------------------ 导入 ------------------------------ */

app.post('/api/docs', async (req, res) => {
  const { collection, files } = req.body || {};
  if (!collection) return fail(res, 'NO_COLLECTION', '请指定资料集');
  if (!Array.isArray(files) || !files.length) return fail(res, 'NO_FILES', '请提供 files:[{name,text}]');
  await db.createCollection(collection);

  const t0 = performance.now();
  const items = [];
  const perFile = [];
  for (const f of files) {
    const name = String(f.name || '未命名.txt');
    const chunks = chunkText(String(f.text || ''));
    perFile.push({ name, chars: String(f.text || '').length, chunks: chunks.length });
    chunks.forEach((text, i) => {
      items.push({
        id: chunkId(name, i),
        text,
        metadata: { source: name, chunk: i, chars: text.length }
      });
    });
  }
  if (!items.length) return fail(res, 'EMPTY', '文档内容为空或过短（每片至少 20 字）');
  const t1 = performance.now();

  // 本地向量化（INT8 模型，进程内推理）
  const vectors = await embedder.embed(items.map((x) => x.text));
  const t2 = performance.now();
  items.forEach((x, i) => (x.embedding = vectors[i]));

  await db.upsertDocs(collection, items);
  const t3 = performance.now();
  await db.refresh(collection);
  const t4 = performance.now();

  // 导入后自检：用最后一片的正文去检索，确认刷新后立即可查
  const probe = items[items.length - 1];
  const probeQuery = probe.text.slice(0, 24);
  const check = await db.search(collection, {
    mode: 'hybrid',
    queryText: probeQuery,
    embedding: probe.embedding,
    k: 5
  });
  const t5 = performance.now();
  const selfCheck = check.hits.some((h) => h.id === probe.id);

  ok(res, {
    collection,
    files: perFile,
    chunks: items.length,
    selfCheck,
    ms: {
      chunk: Math.round(t1 - t0),
      embed: Math.round(t2 - t1),
      write: Math.round(t3 - t2),
      refresh: Math.round(t4 - t3),
      verify: Math.round(t5 - t4),
      total: Math.round(t5 - t0)
    }
  });
});

/* ------------------------------ 检索 ------------------------------ */

app.post('/api/search', async (req, res) => {
  const { collection, query, mode = 'hybrid', k = 8 } = req.body || {};
  if (!collection || !query) return fail(res, 'BAD_REQUEST', '需要 collection 与 query');
  const t0 = performance.now();
  const embedding = await embedder.embedOne(String(query), { query: true });
  const t1 = performance.now();
  const result = await db.search(collection, {
    mode,
    queryText: String(query),
    embedding,
    k: Number(k) || 8
  });
  ok(res, {
    ...result,
    times: { embedMs: Math.round(t1 - t0), searchMs: Math.round(result.ms), totalMs: Math.round(performance.now() - t0) }
  });
});

/* ------------------------------ 提问（检索 + 记忆） ------------------------------ */

app.post('/api/ask', async (req, res) => {
  const { collection, query, learner = 'demo', mode = 'hybrid', k = 8 } = req.body || {};
  if (!collection || !query) return fail(res, 'BAD_REQUEST', '需要 collection 与 query');
  await db.touchLearner(learner);

  const t0 = performance.now();
  const embedding = await embedder.embedOne(String(query), { query: true });
  const t1 = performance.now();
  const result = await db.search(collection, { mode, queryText: String(query), embedding, k: Number(k) || 8 });
  const t2 = performance.now();
  const qa = answerFromHits(String(query), result.hits, { threshold: CONFIG.weakThreshold });

  await db.recordQuestion({
    learner,
    collection,
    question: String(query),
    mode,
    topScore: qa.coverage,
    hitCount: result.hits.length
  });

  // 资料没讲到 → 自动进薄弱点候选（用户也可以手动标记「没懂」）
  let weak = null;
  if (!qa.covered) {
    weak = await db.upsertWeak({
      learner,
      collection,
      concept: conceptKey(query),
      question: String(query),
      evidence: result.hits[0]?.text?.slice(0, 220) || '',
      score: qa.coverage,
      miss: 0
    });
  }

  ok(res, {
    answer: qa.answer,
    covered: qa.covered,
    coverage: qa.coverage,
    bestSim: qa.bestSim,
    citations: qa.citations,
    hits: result.hits,
    weak,
    times: {
      embedMs: Math.round(t1 - t0),
      searchMs: Math.round(t2 - t1),
      totalMs: Math.round(performance.now() - t0)
    }
  });
});

/* ------------------------------ 记忆 ------------------------------ */

app.get('/api/memory', async (req, res) => {
  const learner = String(req.query.learner || 'demo');
  const status = String(req.query.status || 'open');
  const items = await db.listWeak(learner, { status });
  const overview = await db.memoryOverview(learner);
  ok(res, { items, overview });
});

app.post('/api/memory/weak', async (req, res) => {
  const { learner = 'demo', collection, question, evidence = '', score = null, miss = 1 } = req.body || {};
  if (!collection || !question) return fail(res, 'BAD_REQUEST', '需要 collection 与 question');
  const row = await db.upsertWeak({
    learner,
    collection,
    concept: conceptKey(question),
    question,
    evidence,
    score,
    miss
  });
  ok(res, { weak: row });
});

app.post('/api/memory/review', async (req, res) => {
  const { weakId, result } = req.body || {};
  if (!weakId || !['understood', 'still_lost'].includes(result)) {
    return fail(res, 'BAD_REQUEST', '需要 weakId 与 result(understood|still_lost)');
  }
  ok(res, { weak: await db.reviewWeak(Number(weakId), result) });
});

app.get('/api/export/review', async (req, res) => {
  const learner = String(req.query.learner || 'demo');
  const items = await db.listWeak(learner, { status: 'open', limit: 200 });
  const lines = [
    `# 复习清单（学习者：${learner}）`,
    '',
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '| # | 概念 | 资料集 | 标记次数 | 首次提问 | 最近命中分 |',
    '| --- | --- | --- | --- | --- | --- |'
  ];
  items.forEach((w, i) => {
    lines.push(
      `| ${i + 1} | ${w.concept} | ${w.collection} | ${w.misses} | ${new Date(w.created_at).toLocaleDateString('zh-CN')} | ${w.last_score == null ? '-' : Number(w.last_score).toFixed(3)} |`
    );
  });
  lines.push('', '## 原始提问', '');
  items.forEach((w, i) => lines.push(`${i + 1}. ${w.question}`));
  res.type('text/markdown; charset=utf-8').send(lines.join('\n'));
});

/* ------------------------------ 启动 ------------------------------ */

async function boot() {
  try {
    await db.connect();
    console.log(`[shijuan] seekdb ${db.version} connected at ${CONFIG.seekdb.host}:${CONFIG.seekdb.port}/${CONFIG.seekdb.database}`);
  } catch (e) {
    bootError = `seekdb 连接失败：${e.message}`;
    console.error('[shijuan]', bootError);
  }
  // 模型按需加载，避免启动阻塞；首条导入/检索会承担加载时间
  app.listen(CONFIG.port, () => {
    console.log(`[shijuan] http://localhost:${CONFIG.port}`);
  });
}

boot();

process.on('SIGINT', async () => {
  await db.close();
  process.exit(0);
});
