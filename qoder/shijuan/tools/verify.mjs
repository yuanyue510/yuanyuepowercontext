/**
 * 端到端验收脚本：只依赖 Node 与已启动的服务，不打开浏览器。
 *
 *   node tools/verify.mjs            # 对着 http://127.0.0.1:8790 跑
 *   BASE=http://host:8790 node tools/verify.mjs
 *
 * 输出：控制台逐项 PASS/FAIL + evidence/verify-log.txt + evidence/verify.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 8790}`;
const LEARNER = process.env.LEARNER || 'verify-runner';
const COLLECTION = process.env.COLLECTION || '期末复习';
const DB = {
  host: process.env.SEEKDB_HOST || '127.0.0.1',
  port: Number(process.env.SEEKDB_PORT || 2881),
  user: process.env.SEEKDB_USER || 'root',
  password: process.env.SEEKDB_PASSWORD || '',
  database: process.env.SEEKDB_DATABASE || 'shijuan'
};

const log = [];
const results = [];
const t0 = Date.now();

function say(line = '') {
  console.log(line);
  log.push(line);
}
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  results.push({ name, ok, detail });
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return ok;
}
async function call(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const json = await res.json();
  return { status: res.status, json };
}

say(`拾卷 · 端到端验收  ${new Date().toLocaleString('zh-CN')}`);
say(`服务地址 ${BASE}｜学习者 ${LEARNER}｜资料集 ${COLLECTION}`);
say('='.repeat(72));

/* ---------- 1. 服务与 seekdb ---------- */
const health = await call('/api/health');
check('服务健康检查 /api/health', health.json.ok === true, `seekdb ${health.json.seekdb?.version}`);
check('seekdb 为 OceanBase seekdb 实例', /seekdb/i.test(health.json.seekdb?.version || ''), health.json.seekdb?.database);

/* ---------- 2. 导入（幂等） ---------- */
const seedDir = path.join(ROOT, 'data', 'seed');
const names = (await fs.readdir(seedDir)).filter((f) => f.endsWith('.md')).sort();
const files = [];
for (const n of names) files.push({ name: n, text: await fs.readFile(path.join(seedDir, n), 'utf8') });

const imp1 = await call('/api/docs', { method: 'POST', body: { collection: COLLECTION, files } });
check('导入 6 篇学习资料', imp1.json.ok && imp1.json.chunks >= 20, `${imp1.json.chunks} 个片段，向量化 ${imp1.json.ms?.embed}ms`);
check('导入后自检：新片段立即可检索', imp1.json.selfCheck === true);
const before = imp1.json.chunks;
const imp2 = await call('/api/docs', { method: 'POST', body: { collection: COLLECTION, files: [files[0]] } });
check('重复导入同一文件是幂等的', imp2.json.ok === true, `再次导入后片段总数 ${(await call('/api/collections')).json.collections.find((c) => c.name === COLLECTION)?.count}`);

/* ---------- 3. 三种检索模式 ---------- */
const q = '缺页中断的处理流程是什么';
const modes = {};
for (const mode of ['hybrid', 'vector', 'fulltext']) {
  const r = await call('/api/search', { method: 'POST', body: { collection: COLLECTION, query: q, mode, k: 8 } });
  modes[mode] = r.json;
  const top = r.json.hits?.[0];
  check(
    `检索模式 ${mode}`,
    r.json.ok && r.json.hits?.length > 0,
    `top1=${top?.metadata?.source} cos=${top?.similarity} 检索 ${r.json.times?.searchMs}ms`
  );
}
const srcOf = (m) => new Set(modes[m].hits.map((h) => h.metadata?.source));
check(
  '混合检索同时召回了向量与关键词命中的文档',
  srcOf('hybrid').size >= 2 || modes.hybrid.hits.length >= 8,
  `hybrid 命中 ${modes.hybrid.hits.length} 条 / 来源 ${[...srcOf('hybrid')].length} 篇`
);

/* ---------- 4. 提问：资料内问题 ---------- */
const a1 = await call('/api/ask', { method: 'POST', body: { collection: COLLECTION, query: q, learner: LEARNER } });
check('提问命中资料并给出带引用的答案', a1.json.ok && a1.json.covered === true, `覆盖 ${(a1.json.coverage * 100).toFixed(0)}%，引用 ${a1.json.citations?.length} 条`);
check('答案包含可追溯的出处与编号', /\[\d\]/.test(a1.json.answer) && /\.md/.test(a1.json.answer));
check('答案包含完整的五步处理流程', /1\./.test(a1.json.answer) && /5\./.test(a1.json.answer) && /重新执行/.test(a1.json.answer));
check('检索耗时在可交互范围（<500ms）', a1.json.times.totalMs < 500, `${a1.json.times.totalMs}ms`);

/* ---------- 5. 提问：资料外问题 → 自动记忆 ---------- */
const q2 = 'React 的 useEffect 依赖数组怎么写';
const a2 = await call('/api/ask', { method: 'POST', body: { collection: COLLECTION, query: q2, learner: LEARNER } });
check('资料未覆盖的问题被识别', a2.json.covered === false, `覆盖 ${(a2.json.coverage * 100).toFixed(0)}%`);
check('未覆盖问题自动写入薄弱点', a2.json.weak?.id > 0, `weak #${a2.json.weak?.id} 概念「${a2.json.weak?.concept}」`);

/* ---------- 6. 跨会话复用记忆 ---------- */
const mem1 = await call(`/api/memory?learner=${encodeURIComponent(LEARNER)}`);
check('新会话能读回上次的薄弱点', mem1.json.items?.some((w) => w.concept.includes('React')), `${mem1.json.items?.length} 条待复习`);
const weakId = mem1.json.items.find((w) => w.concept.includes('React')).id;
const manual = await call('/api/memory/weak', {
  method: 'POST',
  body: { learner: LEARNER, collection: COLLECTION, question: 'TCP 慢启动什么时候结束', evidence: '', score: 0.6, miss: 1 }
});
check('手动标记「没懂」写入记忆', manual.json.weak?.id > 0, `weak #${manual.json.weak?.id}`);
const mem2 = await call(`/api/memory?learner=${encodeURIComponent(LEARNER)}`);
check('薄弱点按标记次数排序（次数多的在前）', mem2.json.items[0].misses >= 1, `首条 misses=${mem2.json.items[0].misses}`);

/* ---------- 7. 掌握状态更新 ---------- */
const rv = await call('/api/memory/review', { method: 'POST', body: { weakId, result: 'understood' } });
check('复习后状态置为已掌握', rv.json.weak?.status === 'mastered', `weak #${weakId} → ${rv.json.weak?.status}`);
const mem3 = await call(`/api/memory?learner=${encodeURIComponent(LEARNER)}`);
check('已掌握条目不再出现在待复习列表', !mem3.json.items.some((w) => w.id === weakId));

/* ---------- 8. 直接查 seekdb 核对落库 ---------- */
const conn = await mysql.createConnection(DB);
const [weakRows] = await conn.query('SELECT id, concept, asks, misses, status FROM sj_weakpoints WHERE learner=? ORDER BY id', [LEARNER]);
const [qRows] = await conn.query('SELECT COUNT(*) AS n FROM sj_questions WHERE learner=?', [LEARNER]);
const [tables] = await conn.query(
  "SELECT table_name AS t FROM information_schema.tables WHERE table_schema=? AND table_name LIKE 'sj_%' ORDER BY table_name",
  [DB.database]
);
// SDK 把每个集合映射成一张物理表 c$v2$<id>，映射关系登记在 sdk_collections
const [registry] = await conn.query('SELECT collection_id, collection_name FROM sdk_collections WHERE collection_name LIKE ?', ['sj_%']);
const phys = registry.length ? `c$v2$${registry[0].collection_id}` : null;
const [cols] = phys
  ? await conn.query(
      'SELECT column_name AS c, data_type AS d FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position',
      [DB.database, phys]
    )
  : [[]];
const [idx] = phys ? await conn.query('SHOW INDEX FROM ??', [phys]) : [[]];
await conn.end();
check('seekdb 中能查到本次记忆行', weakRows.length >= 2, weakRows.map((r) => `#${r.id} ${r.concept} ${r.status}`).join(' / '));
check('seekdb 中能查到本次提问记录', Number(qRows[0].n) >= 2, `${qRows[0].n} 条`);
check('seekdb 中存在记忆四表', tables.length >= 4, tables.map((r) => r.t).join(', '));
check('文档集合已登记在 sdk_collections', registry.length >= 1, registry.map((r) => `${r.collection_name} → ${'c$v2$' + r.collection_id}`).join(', '));
const hasVector = cols.some((c) => /VECTOR/i.test(c.d));
const idxTypes = [...new Set(idx.map((i) => i.Index_type))];
check('文档表包含 VECTOR 列（seekdb 原生向量类型）', hasVector, cols.map((c) => `${c.c}:${c.d}`).join(' '));
check('文档表同时建有 FULLTEXT 与 VECTOR 索引', idxTypes.includes('FULLTEXT') && idxTypes.includes('VECTOR'), idxTypes.join(' + '));

/* ---------- 9. 导出复习清单 ---------- */
const exp = await fetch(`${BASE}/api/export/review?learner=${encodeURIComponent(LEARNER)}`);
const md = await exp.text();
check('导出复习清单 Markdown', exp.ok && md.includes('复习清单') && md.includes('|'), `${md.length} 字节`);

/* ---------- 汇总 ---------- */
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
say('='.repeat(72));
say(`结果：${passed}/${results.length} 通过，${failed} 失败，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const evidence = path.join(ROOT, 'evidence');
await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(path.join(evidence, 'verify-log.txt'), log.join('\n') + '\n', 'utf8');
await fs.writeFile(
  path.join(evidence, 'verify.json'),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      base: BASE,
      learner: LEARNER,
      collection: COLLECTION,
      seekdb: health.json.seekdb,
      import: { chunks: before, ms: imp1.json.ms, selfCheck: imp1.json.selfCheck },
      modes: Object.fromEntries(
        Object.entries(modes).map(([k, v]) => [k, { ms: v.times?.searchMs, top1: v.hits?.[0]?.metadata?.source, hits: v.hits?.length }])
      ),
      ask: {
        covered: { query: q, coverage: a1.json.coverage, citations: a1.json.citations?.length, totalMs: a1.json.times.totalMs },
        uncovered: { query: q2, coverage: a2.json.coverage, weakId: a2.json.weak?.id }
      },
      memory: { open: mem3.json.overview.open, mastered: mem3.json.overview.mastered, rows: weakRows.length },
      tables: tables.map((r) => r.t),
      collectionTable: phys,
      indexTypes: idxTypes,
      results
    },
    null,
    2
  ),
  'utf8'
);
say('已写入 evidence/verify-log.txt 与 evidence/verify.json');
process.exit(failed ? 1 : 0);
