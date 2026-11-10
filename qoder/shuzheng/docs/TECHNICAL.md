# 技术说明（P7 收口版）

`docs/plan.md` 是给赛题评分看的方案与范围；这份是**实现期实测结论的落点**：改检索、入库、复习任何一条链路之前先读这里。
第七节 1–19 条从 `plan.md` 搬来并保留原编号（便于对照），20–24 条是 P7 验收期间新测出来的。

## 一、一条线的数据流

```
md/txt/html ──section.js──▶ 小节树 ──sentence.js──▶ 句级切片(带 char_start/end、gapBefore)
                                                     │
                                        local-embedder.js（bge-small-zh-v1.5 q8 → 512 维，模长 1）
                                                     │
                            ready.js 就绪门槛 ──▶ seekdb 集合 sh_ds_*（向量 + ngram2 全文）
                                                     │
提问 ─▶ keywords.js（原文子串级关键词）─▶ assemble.js 多路串行召回（k 条全文 + 1 条向量）
                                                     │
                             coverage.js 两条可解释判据 ──┬── 已覆盖 → 抽取式答案（逐句 ref + 区间）
                                                          └── 未覆盖 → 拒答 + stuck 流水 + review 队列
```

四个入口对应四段代码：导入 `server/lib/ingest/pipeline.js`、检索 `server/lib/answer/assemble.js`、
判定 `server/lib/answer/coverage.js`、复习 `server/lib/review/store.js`。HTTP 层只做参数校验和状态码，不含业务判断。

## 二、seekdb 的两种对象，别混用

| 对象 | 实际存放 | 怎么读写 |
| --- | --- | --- |
| 集合（`sh_ds_*`、`sh_stuck`、`sh_probe_ngram`） | 内部表 `c$v2$<uuid>`，`SHOW TABLES` 里看不到集合名 | 只能走 SDK：`add/get/query/hybridSearch/count` |
| 关系表（`sh_registry`、`sh_review`） | 就叫这个名字 | 建表走 `client.execute()`，**写语句要 affectedRows 就另开 mysql2 池**（事实 18） |

所以"直接查库看卡点"要分两条路：`npm run show:review`（关系表，裸 SQL）和 `GET /api/stuck`（集合，SDK）。
P7 期间对 `sh_stuck` 直接写 SQL 会得到 `Table 'shijuan.sh_stuck' doesn't exist` —— 这不是 bug，是集合的本性。

共享库 `shijuan` 里同时存在别的项目的 `sj_*` 表。本项目一律 `sh_` 前缀、一律 `CREATE TABLE IF NOT EXISTS`、
**从不 DROP 任何表**（包括自己的）。库内现状：`sh_registry`、`sh_review`、`sj_collections/sj_learners/sj_questions/sj_reviews/sj_weakpoints`（未触碰）、6 张 `c$v2$*`。

## 三、检索：为什么是这个形状

- **关键词必须来自原文**。`keywords.js` 用 `query.match(/[一-龥]+/g)` 取连续汉字串再按停用词切，所以每个词天然是原问题的
  子串；P7 把这件事写成了断言（verify「查询词必须是原文子串」），一旦将来接了分词器把它改写，测试会立刻红。
- **一词一路，串行发**。`hybridSearch` 依赖连接上的会话变量（事实 13），并发会互相覆盖 `@search_parm`，
  返回"别人那次"的结果。所以 `exclusive()` 排成一条队，`MAX_KEYWORD_CHANNELS` 限流。
- **判定不用任何分数阈值**。`hybridSearch.distances` 是融合名次分（无上界、跨查询不可比，事实 6）；
  只有纯向量 `query()` 的距离是有界 cosine（P7 实测 0.461–0.554）。覆盖判定走两条能讲清楚的规则：
  ① 命中句覆盖的查询词比例 < `COVERAGE_FLOOR = 0.34`；② 没有任何一句同时含 ≥2 个查询词。**两条同时成立才判未覆盖**。
- **`hybridSearch` 是并集融合**（事实 7 + 20）：关键词在教材里根本不存在时，向量近邻照样回来，
  所以"结果为空"永远不能用来判未覆盖；字面命中由 `matchedTerms = terms.filter(t => (sectionTitle + sentence).includes(t))`
  在应用层兜住 —— 证据卡不会出现"看着像但原文没有"的句子。

## 四、就绪门槛：写入完成 ≠ 可检索

`waitUntilReady(collection, expected, probeEmbedding, { intervalMs = 200, timeoutMs = 10_000 })`：

- 读数取 `min(表行数, 向量通道可召回条数)` —— 滞后的只有向量通道（事实 8、16），单看 `count()` 会放行一个搜不出来的集合。
- 放行要求**连续两次读数相同且 ≥ 期望**，不是"够数就走"。
- 超时抛错带实际/期望，导入接口据此返回 500，不做静默降级。
- P7 把负例做成了可测断言：构造 `{count: () => 33, query: () => ({ids: []})}` 的假集合，门槛必须在 300 ms 内
  一直不放行并抛出含实际/期望的错（实测轮询 10 次）。真导入 3 次轮询 ≈ 435 ms 放行。
- 轮询用 `include:['metadatas']`，避免每 200 ms 拖一批 512 维向量回来（事实 14）。

## 五、复习闭环：一行 UPDATE 就是状态机

`sh_review` 的 `id = 'rv_' + sha1(datasetName + '::' + questionText).slice(0,16)` —— 同一问题永远同一行，
所以"反复答不出"表现为 `miss_count +1` 而不是队列变长（P7 实测 6→7 且 `COUNT(*) WHERE id=?` 恒为 1）。

`recordStuck()` 用 `INSERT ... ON DUPLICATE KEY UPDATE miss_count = miss_count + 1, ...`；
状态流转用一条守卫语句，`affectedRows` 是唯一裁判（P6 事实 19，P7 复核：并发 200 + 409，`status_changed_at` 只前进一次）。
合法边只有 `open→reviewing→mastered` 与「任意态→open」回退，回退会把 `mastered_at` 置 NULL
（设计意图：这一列只描述当前状态；历史在 `sh_stuck` 流水里）。

非法边返回 409 且**不碰库**，未知取值 400，id 不存在 404。前端三个按钮的置灰由服务端下发的 `allowed` 决定，
不在前端复刻状态机 —— 状态规则改了，前端不用跟着改。

关系表走 mysql2 连接池，不排在 `exclusive()` 后面：复习列表刷新不该等一次慢检索。

## 六、离线向量化

`@huggingface/transformers` + 本地 `models/bge-small-zh-v1.5/onnx/model_quantized.onnx`（量化版 24 MB，
2026-11-10 已随仓库提交在 `6071896`，克隆即可用、不需要下载 —— 与 README 第二节同一口径），
`env.allowRemoteModels = false`、`dtype: 'q8'`（默认 fp32 会去找不存在的 `model.onnx`），mean-pool 后归一化，输出 512 维单位向量。
查询侧带 bge 指令前缀。建/取集合一律显式 `embeddingFunction: null` —— 既是不碰云端的关键，也绕开 SDK 会去
`import('@seekdb/default-embed')` 的分支（事实 3、9）。该包**未安装**，其 `peerDependencies: workspace:*` 会让 `npm i` 直接失败。

## 七、实测事实清单

1. **过滤能力**：`query` 只有 `queryEmbeddings/queryTexts/nResults`，无 `where` → 分集合 + 检索后本地过滤。
   `hybridSearch` 的 `query.whereDocument.$contains` 可用；`client.execute(sql, params)` 可跑原生 SQL（`sh_registry` 就这么建的）。
2. **写入 API**：`collection.add({ids, documents, embeddings, metadatas})`，维度需与 `VectorIndexConfig` 一致；`getCollection({name})` 取已有集合。
3. **`@seekdb/default-embed` 不能装**：违背约束，且 `peerDependencies: workspace:*` 会让 `npm i` 报 `EUNSUPPORTEDPROTOCOL`；
   `.npmrc: legacy-peer-deps=true` 关闭自动 peer 安装，实测 `node_modules/@seekdb/default-embed` 不存在。
4. **seekdb server 模式是唯一路径**：`192.168.192.131:2881` / 库 `shijuan`，参数走 `.env`；嵌入式在 Windows 不可用
   （`@seekdb/js-bindings` 只发了 `download.js`）。`createCollection(ngram2 + hnsw 512 cosine, embeddingFunction:null)` → `add` → `get` → `hybridSearch` 全链路通过。
5. **中文检索**：`$contains` 对中文短词有效（`"动能"`、`"合外力做功"`）；ngram2 生效（跨词边片段 `"重力加"`、`"能定"` 能召回）；
   返回结构只有 `ids/distances/documents/metadata/embeddings`，**没有 `similarity`**，数组是 `[[...]]` 嵌套。
6. **`distances` 是融合名次分**：固定关键词换向量 → 排序不变、分数小幅变化（1.6416/1.5187/1.5253）；换关键词 → 大幅跳变（命中句 3.155 vs 基线 0.88）。
   纯向量 `query()` 才是有界 cosine。**只能用于排序**，判定一律走可解释规则。
7. **`hybridSearch` 是并集融合，不是 AND 过滤**：教材里完全没有的词仍会返回向量近邻（`洛伦兹力` 返回 3 条）→ 未覆盖不能靠"结果为空"判。
8. **写入后向量通道有可见性延迟**：`add` 完立刻查只召回全文命中的 1 条，T+5s 起稳定 2 条 → 必须有就绪门槛。
9. **`getCollection` 必须显式传 `embeddingFunction: null`**，否则 SDK 去 `import('@seekdb/default-embed')` 抛
   `Embedding function 'default-embed' is not registered`。
10. **`get({ids})` 按表序返回，不保持请求顺序** → 按名次对齐必须自建 id→行 Map，不能下标配对。
11. **transformers.js 离线加载**：`allowRemoteModels=false` + `localModelPath=models/` + `dtype:'q8'`；512 维、模长 1.000000；
    33 条切片向量化 356 ms（P7 复测 149–435 ms，视冷/热）；查询侧指令前缀后目标句 cosine 距离 0.357、无关句 0.563，排序正确。
12. **示例语料端到端**：10 小节 → 33 切片（R1 合并 4 条、残留短句 0）→ 写入 → 混合检索命中，offset 自检一致。
13. **`hybridSearch` 不能并发**：流程是 `SET @search_parm = <json>` → 读回 `query_sql` → 执行；同连接并发会互相覆盖，
    返回别人那次的结果。→ `exclusive()` 队列，检索与入库全部串行，多路关键词也必须串行。
14. **`include` 只裁 documents/metadatas/embeddings**，`ids` 与 `distances` 恒定返回 → 就绪门槛用 `include:['metadatas']` 轮询。
15. **offset 不变式必须由构造保证，不能事后 trim**：R1 直接拼接会丢句间 `\n`，导致 4/33 条切片偏移。
    现在 `splitSentences` 保证 `text === source.slice(charStart, charEnd)`，句间空白记进 `gapBefore` 并在合并时接回；
    `importDataset` 对**全部**切片逐字自检，不一致拒绝放行。P7 复核：A 组 3 条 statement 区间逐字相等。
16. **就绪门槛实测有效**：第 1 次探测 表 33 / 可召回 0，第 2 次 33/33，第 3 次与上次相同 → 放行（间隔 200 ms、上限 10 s）。
    P7 复测：真导入 3 次轮询 ≈ 435 ms。
17. **多路召回的耗时账（P5 观测）**：单关键词 512–705 ms、三关键词 4 通道串行 1179 ms，取的是服务端 `timing.totalMs`
    **首批**样本 → **已被事实 22 推翻为稳态口径**，只在"首请求/共享库争用"语境下引用。
18. **SDK 的 `execute()` 拿不到 affectedRows**：v1.4 `dist/index.mjs:90-99` 只在语句以 `SELECT/SHOW/DESCRIBE` 开头时返回行，其它 `return null`。
    `client._internal.connectionManager.getRawConnection()` 是两层 `@internal` 私有 API（升级会碎）→ 走 seekdb README 推荐的
    **独立 mysql2 连接池**（`server/lib/seekdb/sql.js`）。连接串要按 `user@tenant` 拼（`root@sys`）以与 SDK 的 `fullUser` 对齐，否则连不上。
    `mysql2` 本是 seekdb 依赖（`^3.11.5`，实测解析到 3.24.6），这里只是提为直接依赖，不新增下载。
19. **并发安全 = 一条 UPDATE 的 WHERE 守卫 + affectedRows 裁决**：同时发两次 `open→reviewing`，一条命中守卫返回 200，
    另一条执行时该行已是 reviewing → `affectedRows=0` → 409，`status_changed_at` 只推进一次。
    "先 SELECT 判断再 UPDATE"才是竞态，所以 409 后的那次 SELECT 只用于错误文案。附带好处：关系表不占 `exclusive()`。
20. **`$contains` 的过滤性只在"不带 knn"时成立**（P7 新增，双面实测）：
    - 单独调用：`ADP` → 1 条且逐条字面含词；`专一性` → 1 条；`洛伦兹力` → **0 条** —— 是硬过滤。
    - 带 `knn`：全文命中被顶到第 1，其余名额仍由向量补位；**不存在的词加不加全文条件，结果与基线完全相同**。
      即：融合层只加权不裁剪，AND 语义要靠第 6 条之外的应用层 `includes` 校验。
21. **集合内部表名是 `c$v2$<uuid>`**（P7 新增）：`SHOW TABLES` 看不到集合名，对集合名写裸 SQL 报
    `Table 'shijuan.sh_stuck' doesn't exist`。要"直接看库"必须区分关系表（裸 SQL）与集合（SDK）。
22. **P5 的时延数字不是稳态**（P7 新增）：同一份代码 warm 复测为单词键 31–72 ms、三关键词 4 通道 44–48 ms，
    `C.7 P95 ≤ 800 ms` **达标**；进程冷启动分项 337 ms（`import` 158 + 模型加载 158 + 首次推理 21）。
    结论：报性能必须同时说明 warm/cold，`timing.totalMs` 的首批样本不能当 P95。
    HTTP 层"进程起来后的第一次 /api/search"始终没有数字（收尾那次重启后，第一个被计时的请求已经热过身了），见 README 已知限制第 1 条。
23. **Windows Git Bash 的中文进 curl 参数会被本机代码页转成 GBK**（P7 新增）：`-d '{"query":"中文"}'` 与
    `--data-urlencode "dataset=中文"` 都会发出乱码字节，**后者不报错、只让结果静默变空列表**；
    URL 路径里写中文则被 Node 的 HTTP 解析器判 **400 `URIError: Failed to decode`**。
    统一解法：请求体走 UTF-8 文件 `--data-binary @file`、参数走 `--data-urlencode "name@<Windows 路径>"`、路径走百分号编码。
    （`node -e` 传中文参数不受影响，Node 自己按 UTF-16 取参。）

24. **服务进程到 seekdb 只有一条长连接，空闲被服务端关掉后曾整体报 500 —— 现已自愈**（P7 实测 + 修复）：进程运行约 97 分钟后所有碰库接口
   一律 500 `Can't add new command when connection is in closed state`，而 `/api/health` 的 `portOpen` 仍为 true ——
   因为它只做 TCP 连接探测，不代表会话还活着。根因是 `server/lib/seekdb/client.js:4` 的 `let client` 是模块级单例，
   底下那条连接被服务端超时关掉后没有重建分支；`exclusive()` 也救不了（它管串行，不管连接状态）。
   **修复（用户批准的本期唯一功能豁免）**：`withReconnect(action)` 用一个明确的正则
   （`closed state|can't add new command|PROTOCOL_CONNECTION_LOST|ECONNRESET|connection lost`）认出这一类错误，
   丢掉单例后**只重试一次**；挂在 `openCollection()` 与 `execute()` 这两个"写入之前"的动作上。
   刻意不包 `add()`：重试写在打开阶段，是为了不让一次半途失败的导入重复落库；写到一半才断的场景由**下一个请求**自愈。
   没有加保活心跳（那要引入定时器，收益不超过一次重试）。验收第 24 项盯这个分类逻辑：死连接错误必须第二次成功、
   非死连接错误必须原样抛出、重建后 `openCollection` 仍读到 33 条切片。
   另两条实测边界：原始 SDK 在 `client.close()` 之后**会自己重连**，所以不能用 close 伪造空闲断连（第 24 项只能直接断言分类逻辑）；
   **对照实验顺带成立**——同一时刻 `server/lib/seekdb/sql.js` 那条 mysql2 池照常工作，`npm run show:review` 与复习接口不受影响，
   只有走 SDK 的检索/导入挂掉：两套连接路径是两件独立的事，这在 P6 立事实 18 时是成本，在这里是诊断价值。

## 八、性能实测（P7，`evidence/verify.json` 的 `measurements[]`）

| 项 | 实测 |
| --- | --- |
| 单词键查询（warm，5 次） | 40 / 57 / 59 / 59 / 69 ms，最大 69 ms |
| 三关键词 · 4 通道串行（3 次） | 75 / 83 / 79 ms，中位 79、最大 83 ms |
| 物理篇同形查询（3 通道） | 52 ms |
| 服务端内部拆分（A 组样本，早先一次采集） | `totalMs 49 = embedMs 15 + searchMs 31` |
| 导入 · 向量化 | 物理 428 ms / 生物 146 ms（各 33 条切片） |
| 导入 · 就绪门槛 | 物理 3 次轮询 446 ms / 生物 3 次 425 ms（间隔 200 ms、上限 10 s） |
| 进程冷启动分项 | import 158 + 模型加载 158 + 首次推理 21 = 337 ms |
| `npm run verify` 全程 | 4.19 s，24/24，退出码 0 |

上表是重启后新进程（PID 14512）的稳态数字。同一份代码当天更早一次为 31–72 ms（单词键）、44–48 ms（4 通道），
所以给"稳态"一个区间比给一个数更诚实：**单词键 ≤ 72 ms、4 通道串行 ≤ 83 ms，两次都远低于 `C.7` 的 800 ms**。

## 九、范围外与风险

- **未实现（M1 冻结，返回 501）**：F6 口径体检、F9 沉淀导出、F10 管理面板。`server/index.js:23` 的
  `notImplemented = ['term','export']` 是显式列表，不会静默返回半成品。
- **单进程串行**：`exclusive()` 是进程内 promise 链，多实例部署需要换成 DB 级隔离或每实例独立连接（当前赛题场景不需要）。
- **共享库争用**：`shijuan` 里有别的 `sj_*` 项目在跑，极端情况下事实 22 的 warm 数字可能被拉高；本项目不 DROP、不改别人的表。
- **示例语料口径**：`eval/corpus/*.md` 是自写的常见高中教材口径，不是任何出版社原文，文档和 UI 都不宣称是原文。
- **空闲断连的自愈范围**：`withReconnect()` 只包 `openCollection()` / `execute()`（事实 24）。一次请求如果在 `add()`
  中途断连，本次仍然失败——这是刻意的：重试写入会让半截导入重复落库。下一个请求会先重建单例再走幂等分支，数据不会漂。
- **`hybridSearch` 语义若随 SDK 变化**：事实 7/20 是"并集 + 只加权"，若后续版本改成 AND 过滤，检索③④两项会先红，
  届时应改测试而不是改判定规则 —— 判定永远走 `coverage.js` 两条可解释规则。
