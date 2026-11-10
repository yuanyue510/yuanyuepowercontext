import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../server/config.js';
import { openCollection, getClient, withReconnect } from '../server/lib/seekdb/client.js';
import { sqlSelect, closeSql } from '../server/lib/seekdb/sql.js';
import { waitUntilReady } from '../server/lib/seekdb/ready.js';
import { embedQuery } from '../server/lib/embed/local-embedder.js';
import { reviewIdFor } from '../server/lib/review/store.js';

/**
 * npm run verify：端到端验收。任一断言失败 → 退出码非 0。
 * 输出 evidence/verify-log.txt（人读）与 evidence/verify.json（机读）。
 * 服务需已 npm start；库内断言直连 seekdb，用来证明"改动真在库里"。
 */
const BASE = process.env.BASE_URL || `http://127.0.0.1:${config.http.port}`;
const BIO = '生物必修1-细胞代谢讲义';
const PHYS = '物理必修1-动力学讲义';
const COVERED = '酶有什么特性';
const MULTI = '有氧呼吸哪个阶段释放的能量最多'; // 3 个查询词 → 3 条全文通道 + 1 条向量通道
const UNCOVERED = '洛伦兹力的方向怎么判断';
const ABSENT = '洛伦兹力'; // 两篇语料里都没有的词，用来验全文通道的硬过滤下界
const PROBE = '开普勒第三定律的常数怎么取值'; // 两篇语料里都没有，专门用来驱动复习链路

const lines = [];
const checks = [];
const measurements = [];

const log = (s = '') => {
  lines.push(s);
  console.log(s);
};

/** 把库内轮询过程中被调用方自己 print 的日志一并收进 verify-log.txt。 */
const capture = async (fn) => {
  const original = console.log;
  console.log = (...a) => lines.push(`       ${a.join(' ')}`);
  try {
    return await fn();
  } finally {
    console.log = original;
  }
};

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    checks.push({ name, ok: true, ms: Date.now() - started, detail });
    log(`[PASS] ${name} — ${detail}`);
  } catch (err) {
    checks.push({ name, ok: false, ms: Date.now() - started, detail: err.message });
    log(`[FAIL] ${name} — ${err.message}`);
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** 环境本身不可用时不要把整份报告写成一堆看不懂的连带失败：记一条根因，收摊退出。 */
async function abort(msg) {
  checks.push({ name: '环境可用（后续断言的前提）', ok: false, ms: 0, detail: msg });
  log(`[FAIL] 环境可用（后续断言的前提） — ${msg}`);
  log('');
  log('套件中断：前面是根因，后面的断言没有跑。修好环境再跑一次。');
  await finish();
  process.exit(1);
}

async function req(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const search = (datasetName, query, extra = {}) => req('POST', '/api/search', { datasetName, query, ...extra });
const REVIEW_STATES = ['open', 'reviewing', 'mastered'];
const TABLE = `${config.collection.namespace}review`;
const reviewRow = async (id) => (await sqlSelect(`SELECT * FROM ${TABLE} WHERE id = ?`, [id]))[0] ?? null;
const setState = (id, status) => req('POST', `/api/review/${encodeURIComponent(id)}/state`, { status });
const clock = (ms) => new Date(Number(ms)).toLocaleTimeString('zh-CN', { hour12: false });

/** 把探针卡点复位到 open：状态机断言要从已知起点出发，重复执行才稳定。 */
async function resetToOpen(id) {
  const row = await reviewRow(id);
  if (row && row.status !== 'open') await setState(id, 'open');
}

const startedAt = new Date();
log(`书证 P7 端到端验收  ${startedAt.toLocaleString('zh-CN', { hour12: false })}`);
log(`目标 ${BASE}｜库 ${config.seekdb.host}:${config.seekdb.port}/${config.seekdb.database}｜向量维度 ${config.embedding.dimension}｜全文 ${config.collection.fulltextParser}`);
log('');

// —— 1. 健康与离线红线 ————————————————————————————————————————————————
let doc = { text: '' };
await check('健康自检 / 零云端调用', async () => {
  const { status, data } = await req('GET', '/api/health');
  assert(status === 200, `HTTP ${status}`);
  assert(data.seekdb.portOpen, `seekdb 端口未连通：${data.seekdb.portDetail}`);
  assert(data.offline.modelPresent && data.offline.tokenizerPresent, '本地 ONNX 模型或分词器缺失');
  assert(data.offline.cloudModelCalls === 'forbidden', '健康检查未声明禁止云端模型调用');
  assert(data.offline.embeddingFunction === null, 'embeddingFunction 不是 null（会触发 default-embed 插件）');
  assert(data.seekdb.dimension === 512 && data.seekdb.fulltextParser === 'ngram2', `索引配置漂移 ${JSON.stringify(data.seekdb)}`);
  return `${data.stage}｜${data.seekdb.endpoint}｜模型在位、embeddingFunction=null`;
});

// —— 2. 导入幂等 ————————————————————————————————————————————————
await check('导入幂等（重复导入不产生重复切片）', async () => {
  const text = await fs.readFile(path.join(config.root, 'eval', 'corpus', `${BIO}.md`), 'utf8');
  const runs = [];
  for (let i = 0; i < 2; i += 1) {
    const { status, data } = await req('POST', '/api/dataset/import', { datasetName: BIO, filename: `${BIO}.md`, text });
    assert(status === 200, `第 ${i + 1} 次导入 HTTP ${status}：${JSON.stringify(data)}`);
    assert(data.offsetOk === true, `第 ${i + 1} 次导入 offset 自检未通过`);
    runs.push(data);
  }
  assert(runs[0].chunkCount === runs[1].chunkCount, `两次切片数不同：${runs[0].chunkCount} vs ${runs[1].chunkCount}`);
  const imported = await openCollection(runs[1].collectionName);
  const count = await imported.count();
  assert(count === runs[1].chunkCount, `集合内 ${count} 条 ≠ 本次写入 ${runs[1].chunkCount} 条（有残留或重复）`);
  const ids = (await imported.get({ limit: 500, include: ['metadatas'] })).ids ?? [];
  assert(new Set(ids).size === ids.length, `id 去重后 ${new Set(ids).size} ≠ ${ids.length}，存在重复切片`);
  const reg = (await (await req('GET', '/api/dataset/list')).data.datasets).find((d) => d.name === BIO);
  assert(reg?.chunkCount === count, `登记表 ${reg?.chunkCount} 条 ≠ 集合内 ${count} 条`);
  return `两次均 ${runs[0].chunkCount} 切片｜集合内 ${count} 条、id 全唯一、登记表一致｜就绪门槛 ${runs[0].readyPolls}→${runs[1].readyPolls} 次轮询（${runs[1].readyMs} ms）`;
});

// —— 3. 就绪门槛（负例：行数够但向量通道召不回，不许放行）——————————————
await check('就绪门槛：表行数够、向量通道召回为 0 → 拒绝放行', async () => {
  const fake = { count: async () => 33, query: async () => ({ ids: [] }) };
  let err = null;
  await capture(async () => {
    try {
      await waitUntilReady(fake, 33, [0, 0], { intervalMs: 20, timeoutMs: 300 });
    } catch (e) {
      err = e;
    }
  });
  assert(err, '门槛被放行了 —— 向量通道还没可见就该继续等');
  assert(/实际 count=/.test(err.message) && /期望 33 条/.test(err.message), `超时错误没带实际/期望条数：${err.message}`);
  return `300 ms 上限内一直不放行，报错含实际/期望：${err.message}`;
});

await check('就绪门槛：连续两次读数相同且 ≥ 期望才放行', async () => {
  const fake = { count: async () => 33, query: async () => ({ ids: [[...Array(33).keys()].map(String)] }) };
  const r = await capture(() => waitUntilReady(fake, 33, [0, 0], { intervalMs: 5, timeoutMs: 2000 }));
  assert(r.reading === 33 && r.polls >= 2, `放行条件不成立：reading=${r.reading} polls=${r.polls}`);
  return `第 ${r.polls} 次读数与上次相同（33/33）才放行，耗时 ${r.readyMs} ms`;
});

// —— 4. 三种检索 ————————————————————————————————————————————————
const listRes = await req('GET', '/api/dataset/list');
if (!Array.isArray(listRes.data.datasets)) {
  await abort(`GET /api/dataset/list 不可用：HTTP ${listRes.status} ${JSON.stringify(listRes.data)}`);
}
const bioRow = listRes.data.datasets.find((d) => d.name === BIO);
if (!bioRow) await abort(`资料集「${BIO}」不存在，先跑 npm run seed`);
let col;
let vec;
try {
  col = await openCollection(bioRow.collectionName);
  vec = await embedQuery('酶');
} catch (err) {
  await abort(`打开集合 ${bioRow.collectionName} 或本地向量化失败：${err.message}`);
}

await check('检索①全文通道：$contains 单独调用是硬过滤，语料没有的词返回 0 条', async () => {
  const hit = await col.hybridSearch({ query: { whereDocument: { $contains: 'ADP' } }, nResults: 5 });
  const docs = (hit.documents ?? []).flat().map(String);
  assert(docs.length >= 1, '全文通道对「ADP」零命中');
  const strays = docs.filter((d) => !d.includes('ADP'));
  assert(strays.length === 0, `${strays.length} 条结果不含关键词：${strays[0]?.slice(0, 30)}`);
  const miss = await col.hybridSearch({ query: { whereDocument: { $contains: ABSENT } }, nResults: 5 });
  const missCount = (miss.documents ?? []).flat().length;
  assert(missCount === 0, `语料里根本不存在的「${ABSENT}」召回了 ${missCount} 条`);
  return `「ADP」→ ${docs.length} 条且逐条字面含词（${(hit.ids ?? []).flat().join(',')}）；「${ABSENT}」→ 0 条`;
});

await check('检索②向量通道：query() 给出有界 cosine 距离', async () => {
  const res = await col.query({ queryEmbeddings: [vec], nResults: 5, include: ['metadatas'] });
  const distances = res.distances?.flat() ?? [];
  assert(distances.length === 5, `只返回 ${distances.length} 条`);
  assert(distances.every((d) => d >= 0 && d <= 2), `cosine 距离越界：${distances}`);
  return `Top5 距离 ${distances.map((d) => d.toFixed(3)).join(' / ')}（有界可比较，故排序之外不用它做判据）`;
});

await check('检索③融合语义：全文命中被顶到第 1、向量补位（并集而非 AND 过滤）', async () => {
  const flat = (r) => ({ ids: (r.ids ?? []).flat().map(String), docs: (r.documents ?? []).flat().map(String) });
  const base = flat(await col.hybridSearch({ query: {}, knn: { queryEmbeddings: [vec] }, nResults: 5 }));
  const ft = flat(await col.hybridSearch({ query: { whereDocument: { $contains: 'ADP' } }, nResults: 5 }));
  const fused = flat(await col.hybridSearch({ query: { whereDocument: { $contains: 'ADP' } }, knn: { queryEmbeddings: [vec] }, nResults: 5 }));
  assert(fused.ids.length === 5 && base.ids.length === 5, `条数不对：融合 ${fused.ids.length} / 基线 ${base.ids.length}`);
  assert(ft.ids.length >= 1 && fused.ids[0] === ft.ids[0], `全文命中没排到第 1：融合第 1 = ${fused.ids[0]}，全文通道 = ${ft.ids.join('/')}`);
  assert(fused.ids.join() !== base.ids.join(), '加了全文条件顺序却没变，全文通道未参与融合');
  const orphans = fused.ids.filter((id) => !base.ids.includes(id) && !ft.ids.includes(id));
  assert(orphans.length === 0, `融合结果里冒出两条通道都没有的 ${orphans.join('/')}`);
  const strays = fused.docs.filter((d, i) => !base.ids.includes(fused.ids[i]) && !d.includes('ADP'));
  assert(strays.length === 0, `${strays.length} 条既非向量补位也不含全文词`);
  const rank = base.ids.indexOf(ft.ids[0]);
  return `全文命中的 ${ft.ids[0]} 升到第 1（基线里${rank < 0 ? '根本不在 Top5' : `排第 ${rank + 1}`}），其余 ${fused.ids.length - 1} 条由向量补位；实测确认 knn 在场时全文条件只加权、不做硬过滤（assemble.js:15 的并集融合结论复核成立）`;
});

await check('检索④多路并行：/api/search 融合 k 条全文 + 1 条向量', async () => {
  const { status, data } = await search(BIO, MULTI);
  assert(status === 200, `HTTP ${status}`);
  const hybrid = data.channels.filter((c) => c.type === 'hybrid');
  const vector = data.channels.filter((c) => c.type === 'vector');
  assert(hybrid.length >= 2 && vector.length === 1, `通道构成异常：${JSON.stringify(data.channels)}`);
  const counts = data.evidence.map((c) => c.channelCount);
  assert(counts.every((v, i) => i === 0 || counts[i - 1] >= v), `证据卡没按命中通道数降序：${counts}`);
  const keywords = hybrid.map((c) => c.keyword);
  assert(new Set(keywords).size === keywords.length, `有重复的全文通道：${keywords.join('/')}`);
  return `${data.terms.length} 个查询词 → ${hybrid.length} 条全文通道（${keywords.join('/')}）+ ${vector.length} 条向量通道，融合 ${data.evidence.length} 张卡，channelCount 序列 ${counts.join('')}`;
});

// —— 5. 覆盖判定与 offset / 子串断言 ————————————————————————————————————————————
await check('已覆盖判定：给出抽取式答案而不是编造', async () => {
  const { data } = await search(BIO, COVERED);
  assert(data.coverage.covered, `判为未覆盖：${JSON.stringify(data.coverage)}`);
  assert(data.confidence !== 'none', '置信度为 none');
  assert(data.answer.kind === 'extractive' && data.answer.statements.length > 0, '没有抽取式答案');
  assert(data.stuck === null, '已覆盖却写了卡点');
  return `覆盖率 ${data.coverage.coverage}（≥${data.coverage.coverageFloor}）｜最强一句含 ${data.coverage.witnessTermCount} 词｜置信 ${data.confidence}｜答案 ${data.answer.statements.length} 句`;
});

doc = (await (await req('GET', `/api/dataset/${encodeURIComponent(BIO)}/text`)).data);
if (typeof doc.text !== 'string' || !doc.text.length) {
  await abort(`取原文失败，offset 与子串断言没有比对基准：${JSON.stringify(doc).slice(0, 160)}`);
}

await check('证据卡 offset 逐字一致（点引用跳原文不偏一个字）', async () => {
  const { data } = await search(BIO, MULTI);
  const bad = data.answer.statements.filter((s) => doc.text.slice(s.charStart, s.charEnd) !== s.sentence);
  assert(bad.length === 0, `${bad.length} 条定位区间与原句不一致：${JSON.stringify(bad[0])}`);
  return `${data.answer.statements.length} 条 statements 的 char_start–char_end 全部逐字命中（全文 ${doc.charCount} 字）`;
});

await check('查询词必须是原文的子串（否则失败）', async () => {
  const queries = [COVERED, 'ATP与ADP怎么相互转化', MULTI, '酶的专一性怎么理解'];
  const seen = [];
  const keywords = [];
  for (const q of queries) {
    const { data } = await search(BIO, q);
    for (const term of data.terms) {
      assert(q.includes(term), `查询词「${term}」不是原问题「${q}」的子串（关键词抽取越出了原文）`);
      seen.push(term);
    }
    for (const channel of data.channels) {
      if (channel.keyword == null) continue;
      assert(q.includes(channel.keyword), `检索通道关键词「${channel.keyword}」不是原问题的子串`);
      keywords.push(channel.keyword);
    }
    for (const card of data.evidence) {
      assert(doc.text.includes(card.sentence), `证据卡原句不在资料原文里：${card.sentence.slice(0, 20)}`);
      for (const term of card.matchedTerms) {
        assert(
          card.sentence.includes(term) || card.sectionTitle.includes(term),
          `命中词「${term}」既不在原句也不在小节标题里（卡片 ${card.id}）`,
        );
      }
    }
  }
  assert(seen.length > 0, '一条查询词都没抽到，子串断言没有实际生效');
  return `${queries.length} 条查询共 ${seen.length} 个查询词、${keywords.length} 条通道关键词，全部是原问题子串；证据卡原句均能在原文中定位`;
});

await check('未覆盖拒答：不给无出处内容', async () => {
  const { data } = await search(BIO, UNCOVERED);
  assert(data.confidence === 'none' && data.answer.kind === 'refusal', `没有拒答：${data.confidence}/${data.answer.kind}`);
  assert(data.answer.statements.length === 0, '拒答里还夹着 statements');
  assert(data.answer.text.includes('判据①') && data.answer.text.includes('判据②'), `拒答文案没引用两条判据：${data.answer.text}`);
  assert(data.coverage.rule1LowCoverage && data.coverage.rule2NoSharedTermSentence, '两条规则并非同时成立');
  return `覆盖率 ${data.coverage.coverage}｜未出现词 ${data.coverage.missedTerms.join('/')}｜只列最近 ${data.answer.nearestRefs.length} 条原文且声明不构成答案`;
});

// —— 6. 卡点落库与错次累加 ————————————————————————————————————————————
const stuckBefore = (await (await req('GET', '/api/stuck?limit=1')).data).total;
const probeId = reviewIdFor(BIO, PROBE);

await check('卡点落库：流水 + 复习队列各写一处', async () => {
  await resetToOpen(probeId);
  const a = await search(BIO, PROBE);
  assert(a.data.stuck?.stuckId, `检索没返回卡点 id：${JSON.stringify(a.data.stuck)}`);
  const stuckAfter = (await (await req('GET', '/api/stuck?limit=1')).data).total;
  const row = await reviewRow(probeId);
  assert(row, `库内 ${TABLE} 没有 ${probeId}`);
  assert(stuckAfter === stuckBefore + 1, `sh_stuck 应 +1，实际 ${stuckBefore} → ${stuckAfter}`);
  assert(a.data.stuck.reviewId === probeId, `返回的 reviewId 与本地算法不一致：${a.data.stuck.reviewId} vs ${probeId}`);
  assert(row.status === 'open', `落队列状态不是 open：${row.status}`);
  return `流水 sh_stuck ${stuckBefore}→${stuckAfter}（${a.data.stuck.stuckId}）｜队列 ${probeId} status=open miss=${row.miss_count} doc=${row.nearest_doc_id}`;
});

await check('错次累加：同一问题再问只 +1 错次，不多建行', async () => {
  const before = await reviewRow(probeId);
  const b = await search(BIO, PROBE);
  const after = await reviewRow(probeId);
  const rows = (await sqlSelect(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE id = ?`, [probeId]))[0].n;
  assert(b.data.stuck.reviewId === probeId, `第二次落到了别的 id：${b.data.stuck.reviewId}`);
  assert(Number(after.miss_count) === Number(before.miss_count) + 1, `miss_count 应 +1：${before.miss_count} → ${after.miss_count}`);
  assert(Number(rows) === 1, `同一问题有 ${rows} 行`);
  assert(after.latest_stuck_id !== before.latest_stuck_id, `latest_stuck_id 没指向新流水：${after.latest_stuck_id}`);
  assert(after.mastered_at === null || after.mastered_at === undefined, '累加错次时 mastered_at 应被清空');
  return `${probeId}：miss_count ${before.miss_count}→${after.miss_count}，行数仍为 1，latest_stuck_id ${before.latest_stuck_id}→${after.latest_stuck_id}`;
});

// —— 7. 状态机 200 / 409 / 400 / 404 与并发 ——————————————————————————————————
await check('状态机 200：open→reviewing', async () => {
  await resetToOpen(probeId);
  const r = await setState(probeId, 'reviewing');
  assert(r.status === 200, `期望 200，实际 HTTP ${r.status}：${JSON.stringify(r.data)}`);
  assert(r.data.row.status === 'reviewing', `返回体状态不对：${JSON.stringify(r.data.row)}`);
  const row = await reviewRow(probeId);
  assert(row.status === 'reviewing', `库内 status=${row.status}`);
  return `HTTP 200，库内 status=reviewing，status_changed_at=${clock(row.status_changed_at)}`;
});

await check('状态机 409：重复提交同一边被守卫挡下', async () => {
  const r = await setState(probeId, 'reviewing');
  assert(r.status === 409, `期望 409，实际 HTTP ${r.status}`);
  assert(r.data.from === 'reviewing' && r.data.allowed.includes('mastered'), `409 没回当前状态与可去向：${JSON.stringify(r.data)}`);
  return `HTTP 409：${r.data.error}｜allowed=[${r.data.allowed.join('/')}]`;
});

await check('状态机 400 / 404：非法取值与不存在的卡点', async () => {
  const bad = await setState(probeId, 'done');
  const missing = await setState('rv_not_exist_at_all', 'reviewing');
  assert(bad.status === 400, `非法 status 应 400，实际 ${bad.status}`);
  assert(missing.status === 404, `不存在的 id 应 404，实际 ${missing.status}`);
  const row = await reviewRow(probeId);
  assert(row.status === 'reviewing', `非法请求把状态改坏了：${row.status}`);
  return `status=done → 400；id=rv_not_exist_at_all → 404；两者都没动库（status 仍 reviewing）`;
});

await check('并发只推进一次：同时两次 open→reviewing', async () => {
  await resetToOpen(probeId);
  const before = await reviewRow(probeId);
  const rs = await Promise.all([setState(probeId, 'reviewing'), setState(probeId, 'reviewing')]);
  const codes = rs.map((r) => r.status).sort();
  const after = await reviewRow(probeId);
  assert(codes[0] === 200 && codes[1] === 409, `两个请求都成功或都失败：${codes}`);
  assert(after.status === 'reviewing', `库内状态不是 reviewing：${after.status}`);
  assert(Number(after.status_changed_at) > Number(before.status_changed_at), 'status_changed_at 没推进');
  return `HTTP ${codes.join(' + ')}｜status_changed_at ${clock(before.status_changed_at)}→${clock(after.status_changed_at)}（只推进一次）`;
});

await check('mastered 后离队：不再出现在待复习列表', async () => {
  const m = await setState(probeId, 'mastered');
  assert(m.status === 200, `reviewing→mastered HTTP ${m.status}：${JSON.stringify(m.data)}`);
  const row = await reviewRow(probeId);
  assert(row.mastered_at && Number(row.mastered_at) > 0, 'mastered_at 没写');
  const list = (await (await req('GET', '/api/review?limit=200')).data).pending;
  assert(!list.some((r) => r.id === probeId), '已掌握的卡点仍在待复习队列里');
  const counts = (await (await req('GET', '/api/review?limit=200')).data).counts;
  assert((counts.mastered ?? 0) >= 1, `counts.mastered 应 ≥1：${JSON.stringify(counts)}`);
  const back = await setState(probeId, 'open');
  const reset = await reviewRow(probeId);
  assert(back.status === 200 && reset.mastered_at === null, `回退 open 没清空 mastered_at：${reset.mastered_at}`);
  return `mastered_at=${clock(row.mastered_at)}，队列已不含 ${probeId}（counts=${JSON.stringify(counts)}）；回退 open 后 mastered_at=${reset.mastered_at}（已清空，见 README 已知限制）`;
});

// —— 8. 复习页数据源与前端资源 ——————————————————————————————————
await check('复习页非空：字段齐全且排序正确', async () => {
  const { data } = await req('GET', `/api/review?dataset=${encodeURIComponent(BIO)}&limit=50`);
  assert(data.pending.length >= 1, `队列为空：${JSON.stringify(data.counts)}`);
  for (const r of data.pending) {
    for (const f of ['id', 'concept', 'questionText', 'coverage', 'nearestDocId', 'status', 'missCount', 'allowed']) {
      assert(r[f] !== undefined, `缺字段 ${f}`);
    }
    assert(REVIEW_STATES.includes(r.status), `状态取值非法：${r.status}`);
  }
  const expected = [...data.pending].sort((a, b) => b.missCount - a.missCount || a.lastSeen - b.lastSeen).map((r) => r.id);
  assert(JSON.stringify(expected) === JSON.stringify(data.pending.map((r) => r.id)), `排序不是 miss_count DESC, last_seen ASC：${data.pending.map((r) => `${r.missCount}/${r.lastSeen}`).join(' ')}`);
  return `${data.pending.length} 条待复习（最多错 ${data.pending[0].missCount} 次），8 个必需字段齐全，排序与服务端 SQL 一致`;
});

await check('复习页空态：空队列返回空数组 + 前端文案在位', async () => {
  const { status, data } = await req('GET', `/api/review?dataset=${encodeURIComponent('不存在的资料集-用于空态断言')}&limit=50`);
  assert(status === 200, `HTTP ${status}`);
  assert(Array.isArray(data.pending) && data.pending.length === 0, `过滤后不该有数据：${data.pending?.length}`);
  const view = await (await fetch(`${BASE}/js/views/review.js`)).text();
  const html = await (await fetch(`${BASE}/index.html`)).text();
  for (const needle of ['还没有卡点', '还没懂', '在复习', '已掌握']) {
    assert(view.includes(needle), `前端源码缺「${needle}」`);
  }
  assert(html.includes('data-view="review"'), 'index.html 没有复习标签页');
  return `空数据集过滤 → HTTP 200 且 pending=[]（${JSON.stringify(data.counts)}）；前端源码含「还没有卡点」与三个按钮文案（DOM 行为见 VERIFICATION.md 的人工验证）`;
});

// —— 9. 时延实测 ————————————————————————————————————————————————
await check('时延：单词键查询 warm P95 ≤ 800 ms', async () => {
  const samples = [];
  for (const q of ['酶有什么特性', 'ATP与ADP怎么相互转化', '光合作用的光反应产物', '有氧呼吸的产物', '无氧呼吸在哪里进行']) {
    const t = Date.now();
    await search(BIO, q);
    samples.push(Date.now() - t);
  }
  const warm = [...samples].sort((a, b) => a - b);
  const p95 = warm[warm.length - 1];
  measurements.push({ name: '单词键查询时延样本(ms)', value: samples, thresholdMs: 800 });
  assert(p95 <= 800, `时延超标：${samples.join('/')} ms`);
  return `样本 ${samples.join('/')} ms（最大 ${p95} ms ≤ 800）`;
});

await check('时延：多关键词 4 通道串行（记录实测，超 800 ms 只列已知限制）', async () => {
  const samples = [];
  let channels = 0;
  for (let i = 0; i < 3; i += 1) {
    const t = Date.now();
    const { data } = await search(BIO, MULTI);
    samples.push(Date.now() - t);
    channels = data.channels.length;
    assert(channels >= 4, `通道数不对：${channels}`);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[1];
  const physics = await search(PHYS, '牛顿第二定律的适用范围是什么');
  const tp = Date.now();
  await search(PHYS, '牛顿第二定律的适用范围是什么');
  const physMs = Date.now() - tp;
  measurements.push({
    name: '多关键词查询时延(ms)',
    value: samples,
    median,
    max: sorted[sorted.length - 1],
    query: MULTI,
    channels,
    physicsQuery: '牛顿第二定律的适用范围是什么',
    physicsChannels: physics.data.channels.length,
    physicsMs: physMs,
    note: sorted[sorted.length - 1] > 800 ? 'C.7 P95≤800ms 未达标，列入已知限制' : '达标',
  });
  log(`       └ ${MULTI}（${channels} 条通道）实测 ${samples.join('/')} ms；${physics.data.channels.length} 条通道的物理篇同形查询 ${physMs} ms`);
  assert(median <= 800, `多关键词中位数超标：${samples.join('/')} ms`);
  return `3 次 ${samples.join('/')} ms（中位 ${median} ≤ 800），最大 ${sorted[sorted.length - 1]} ms${sorted[sorted.length - 1] > 800 ? '（超标 → README 已知限制）' : '（达标）'}`;
});

// —— 10. 死连接自愈（P7 实测到的长期空闲问题，README 已知限制第 8 条）——————————————
await check('死连接自愈：withReconnect 只重试这一类错误，且重试后真实取集合仍可用', async () => {
  let calls = 0;
  const healed = await withReconnect(async () => {
    calls += 1;
    if (calls === 1) throw new Error("Can't add new command when connection is in closed state");
    return 'ok';
  });
  assert(healed === 'ok' && calls === 2, `死连接错误没有被重试：调用 ${calls} 次，结果 ${healed}`);

  let leaked = null;
  try {
    await withReconnect(async () => {
      throw new Error('集合名不合法');
    });
  } catch (err) {
    leaked = err;
  }
  assert(leaked && calls === 2, `非死连接错误也被重试了（会把真 bug 和重复写入放大）：调用 ${calls} 次`);

  const again = await openCollection(bioRow.collectionName);
  const n = await again.count();
  assert(n > 0, `重连之后取集合拿不到数据：count=${n}`);
  const health = await req('GET', '/api/health');
  assert(health.status === 200 && health.data.seekdb.portOpen, `健康检查异常：${JSON.stringify(health.data).slice(0, 120)}`);
  return `死连接错误重试 1 次后成功；非法错误没有被误重试；单例重建后 openCollection 仍读到 ${n} 条切片`;
});

// —— 汇总 ————————————————————————————————————————————————
async function finish() {
  const failed = checks.filter((c) => !c.ok);
  const finishedAt = new Date();
  log('');
  log(`合计 ${checks.length} 项：通过 ${checks.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) for (const f of failed) log(`  失败：${f.name} — ${f.detail}`);
  if (failed.some((f) => /closed state|ECONNREFUSED|PROTOCOL_CONNECTION_LOST|Can't add new command/.test(f.detail))) {
    log('  ↳ 根因像是服务进程到 seekdb 的那条连接已断开（长期空闲后不会自愈，README 已知限制第 8 条）：重启 npm start 再跑。');
  }
  log(`目标 ${BASE}｜开始 ${startedAt.toISOString()}｜结束 ${finishedAt.toISOString()}`);

  const evidenceDir = path.join(config.root, 'evidence');
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(
    path.join(evidenceDir, 'verify.json'),
    JSON.stringify(
      { base: BASE, startedAt, finishedAt, exitCode: failed.length ? 1 : 0, passed: checks.length - failed.length, failed: failed.length, checks, measurements },
      null,
      2,
    ),
    'utf8',
  );
  await fs.writeFile(path.join(evidenceDir, 'verify-log.txt'), `${lines.join('\n')}\n`, 'utf8');

  await closeSql();
  await getClient().close().catch(() => {});
  return failed.length;
}

process.exit((await finish()) ? 1 : 0);
