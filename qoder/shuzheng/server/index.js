import express from 'express';
import { config } from './config.js';
import { healthRouter } from './routes/health.js';
import { datasetRouter, initRegistry } from './routes/dataset.js';
import { searchRouter } from './routes/search.js';
import { stuckRouter } from './routes/stuck.js';
import { reviewRouter } from './routes/review.js';
import { ensureReviewTable } from './lib/review/store.js';
import { closeSql } from './lib/seekdb/sql.js';

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use('/api/health', healthRouter);
app.use('/api/dataset', datasetRouter);
app.use('/api/search', searchRouter);
app.use('/api/stuck', stuckRouter);
app.use('/api/review', reviewRouter);

// 已定范围外（可选扩展）：F3 术语口径、F6 口径体检、F9 导出。
// F5 的抽取式答案不单独开接口：答案与证据卡由 /api/search 一次返回，避免前端两次拼装。
// F7 的"未覆盖 → 落卡点"已在检索里写通，/api/stuck 是只读流水；F8 的复习闭环走 /api/review。
const notImplemented = ['term', 'export'];
for (const name of notImplemented) {
  app.use(`/api/${name}`, (req, res) => {
    res.status(501).json({ error: 'not_implemented', module: name });
  });
}

app.use(express.static(config.paths.public));

const server = app.listen(config.http.port, async () => {
  console.log(`[shuzheng] http://localhost:${config.http.port}`);
  // 注册表建不起来就报错并保持业务接口返回 503：异常必须可见，不静默降级（验收点 C.9）。
  const reg = await initRegistry();
  console.log(reg.ok ? `[registry] ${config.collection.namespace}registry 就绪` : `[registry] 失败：${reg.error}`);
  try {
    await ensureReviewTable();
    console.log(`[review] ${config.collection.namespace}review 就绪`);
  } catch (err) {
    console.log(`[review] 失败：${err.message}`); // 不阻断启动：store.js 里每次进来会重试
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await closeSql().catch(() => {});
    server.close(() => process.exit(0));
  });
}
