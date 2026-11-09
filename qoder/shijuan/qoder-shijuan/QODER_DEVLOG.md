# Qoder 开发记录

> 这份文件是**给你（参赛者）用的操作手册 + 记录模板**，不是事后编的故事。
> 赛题 3.1 要求「开发记录能够体现项目的主要功能由 Qoder 参与完成」，4.4 要求提交**对话截图或录屏 + Qoder 账号 UID**。下面每一步都要在 Qoder 里真实发生，截图/录屏存到 `docs/qoder/`。

---

## 0. 先补齐三件事

| 项 | 说明 |
|---|---|
| 安装 Qoder | 桌面端 / IDE 插件 / JetBrains / CLI 任选，登录**个人账号**（企业版无法把 Sites 设为「任何人都可访问」） |
| 拿到 UID | Qoder 账号设置页可以看到 UID；填到下表和第 5 节 |
| 建仓库 | 本项目推到一个**新的公开仓库**（不要和 Dify / StepFun 赛题的仓库混在一起，避免根 README 冲突） |

填这张表（提交时要发给平台）：

| 字段 | 值 |
|---|---|
| Qoder 账号 UID | `1940117489165517`（阿里云账号 ID，Qoder 以阿里云账号登录） |
| Qoder Sites 网址 | `待填写`（发布后形如 `https://xxx.qoder.site`） |
| 代码仓库 | `https://github.com/yuanyue510/yuanyuepowercontext/tree/2026-competition-ecosystem/qoder/shijuan` |
| 开发起止时间 | `2026-11-09`（Qoder 会话完成后按实际日期订正，形如 `2026-11-09 ~ 2026-11-12`） |

> UID 仅用于赛事材料核对（站点归属与使用记录），不在项目网站的公开页面展示；网站「关于」处写的是「UID 见本文件」。

---

## 1. 开发节奏

10 个阶段，每阶段一次 Qoder 会话 + 一次 git commit。commit 信息写清阶段（例如 `feat(seekdb): 集合封装与混合检索`），这样时间线、对话记录、代码三者能对上，评审一眼能核。

| 阶段 | Qoder 做的事 | 产出 | 截图 |
|---|---|---|---|
| P1 需求拆解 | 读赛题，输出功能清单与数据模型 | `docs/plan.md` | `01-plan.png` |
| P2 脚手架 | 初始化 Node 项目、依赖、目录、`.env.example` | `package.json` 等 | `02-scaffold.png` |
| P3 seekdb 接入 | 连接、建库、集合封装、记忆表 DDL | `server/db.mjs` | `03-db.png` |
| P4 切片与向量化 | 中文切片 + 本地 bge 推理 | `server/chunk.mjs` `server/embed.mjs` | `04-embed.png` |
| P5 导入接口 | 切片→向量化→upsert→刷新→自检 | `/api/docs` | `05-ingest.png` |
| P6 三种检索 | hybrid / vector / fulltext | `/api/search` | `06-search.png` |
| P7 答案抽取 | 段落合并、词权重、引用编号 | `server/qa.mjs` | `07-qa.png` |
| P8 记忆闭环 | 四表 + 提问记录 + 复习状态 | `/api/ask` `/api/memory/*` | `08-memory.png` |
| P9 前端 | 三标签页单页界面，零构建 | `public/*` | `09-ui.png` |
| P10 验收与站点 | verify 脚本、文档、Qoder Sites 发布 | `tools/verify.mjs` `site/` | `10-site.png` |

---

## 2. 可直接粘进 Qoder 的提示词

> 用法：按顺序粘，**每粘一条先让它把方案说清楚再动手**，跑通、提交，然后进下一条。中途它做偏了就直接指出偏差（这些纠正过程本身就是很好的开发记录素材）。

**P1 需求拆解**

```
我要参加「Qoder × OceanBase · Build with Qoder」比赛，做一个学习科研提效项目。
痛点：复习时找不到资料里的原句；通用大模型答得顺但口径和教材对不上；当时没读懂的概念事后忘了卡在哪。
约束：
1. 必须用 seekdb 提供数据存储、查询与检索能力（向量 + 全文混合检索）；
2. 不调用任何云端大模型或 embedding 接口，要能离线跑；
3. 前端零构建，npm start 就能用。
请先不要写代码，输出：功能清单（按用户操作顺序）、数据模型（表/字段/索引）、技术选型理由、目录结构、验收点。
```

**P2 脚手架**

```
按你上面的方案建 Node 项目：ESM、Express、端口 8790、原生前端。
依赖只要 express、seekdb、mysql2、@huggingface/transformers。
建 server/ public/ data/seed/ scripts/ tools/ 目录，写 .env.example（SEEKDB_HOST/PORT/USER/PASSWORD/DATABASE、PORT、EMBED_DTYPE、WEAK_THRESHOLD），写 .gitignore（node_modules、.env、models）。
npm scripts：start / seed / verify / reset / fetch-models。
```

**P3 seekdb 接入**

```
写 server/db.mjs：
1. 用 seekdb 的 AdminClient 确保 database `shijuan` 存在，再用 SeekdbClient 连接；
2. 文档集合：每个资料集一张表，列 embedding VECTOR(512) 走 HNSW cosine（M=16, efC=200, efS=128），document 走 ngram2 全文索引，metadata 存 JSON；
3. 注意 seekdb 集合名只允许 [a-zA-Z0-9_]，中文资料集名要用 sha256 前 10 位映射成 slug，标签存 sj_collections 表；
4. 记忆四表 sj_learners / sj_questions / sj_weakpoints / sj_reviews，用 mysql2 连接池（避免空闲连接被回收），弱点是 (learner, collection, concept) 唯一；
5. 导出 listCollections / createCollection / deleteCollection / upsertDocs / refresh / search(label, {mode, queryText, embedding, k})。
search 必须调用 col.hybridSearch()，RRF 交给 seekdb 的 DBMS_HYBRID_SEARCH，不要在应用层合并两路结果。
```

**P4 切片与向量化**

```
写 server/chunk.mjs 和 server/embed.mjs：
- 切片：320 字一片、重叠 60 字，优先在段落边界断开，单段超长再按句号切；片段 id = 文件名清洗后 + #序号（补零三位），保证重复导入幂等；
- 向量化：@huggingface/transformers 加载本地 bge-small-zh-v1.5（INT8，路径 models/，设 env.allowRemoteModels=false），pooling=cls、normalize=true；查询侧加 bge 官方前缀「为这个句子生成表示以用于检索相关文章：」，文档侧不加；批量 8 条；加载后预热一次。
再写 scripts/fetch-models.mjs 从 hf-mirror 下载 config/tokenizer/onnx/model_quantized.onnx。
```

**P5 导入接口**

```
实现 POST /api/docs：{collection, files:[{name,text}]}
流程：建集合（若不存在）→ 切片 → 批量向量化 → upsert → refresh_index → 用最后一片的正文做一次检索自检。
返回 {chunks, files:[{name,chars,chunks}], selfCheck, ms:{chunk,embed,write,refresh,verify,total}}。
自检不通过要如实返回 selfCheck:false，不要假装成功。
```

**P6 三种检索**

```
实现 POST /api/search：{collection, query, mode: hybrid|vector|fulltext, k}
- hybrid：hybridSearch 的全文 + knn 两路各取 40，RRF rankConstant=60、rankWindowSize=40，返回 top-k；
- vector：col.query 走 HNSW；
- fulltext：hybridSearch 只给 query.whereDocument.$contains。
返回每条 {id, rank, score, similarity=1-distance, text, metadata} 和 times:{embedMs, searchMs, totalMs}。
```

**P7 答案抽取**

```
写 server/qa.mjs 的 answerFromHits(question, hits)：
1. 片段按空行切段，丢弃 Markdown 标题；以冒号结尾的引导句要和后面的编号列表合并（否则「分五步：」会把五步丢掉）；
2. 查询切中文 2-gram + 英文 token，过滤停用词；
3. 段落打分 = 命中词的 log(1+段落数/(1+df)) 之和 × 名次权重 1/(1+rank*0.4) × 长段落惩罚；
4. 要求命中 ≥2 词、与已选段落重合度 <0.45、第二条与第一条同源；
5. 输出 `- 段落… [n]`，n 为片段序号；
6. 另外算查询词覆盖率（命中片段中出现的比例），<0.34 时开头写「资料里没有正面讲到……」，covered=false。
不要调用任何大模型。
```

**P8 记忆闭环**

```
实现 POST /api/ask：检索 → 生成答案 → 写 sj_questions（topScore 存覆盖率）→ 若 covered=false 自动 upsert 薄弱点（concept 由问题去标点、去「请问/帮我看看」前缀后截 40 字）。
再实现 GET /api/memory?learner=（待复习列表 + 统计）、POST /api/memory/weak（手动标记没懂，misses+1）、POST /api/memory/review（understood → status=mastered，仍不懂计数+1）、GET /api/export/review（导出 Markdown）。
复习列表按 misses DESC, asks DESC, updated_at DESC 排。
```

**P9 前端**

```
写 public/index.html + styles.css + app.js（原生 JS，无构建）：
左侧资料集列表（新建/切换/删除）+ 学习者输入；三个标签页：
「提问」输入框 + 模式选择 + TopK + 答案卡片（覆盖标签、耗时、[n] 引用、没懂按钮）+ 片段列表（details 展开看原文）；
「资料」粘贴/选文件导入 + 导入报告（各阶段耗时、自检结果）+ 资料集表格；
「复习」统计卡片 + 薄弱点条目（懂了/还是不懂）+ 导出清单。
配色米白底 + 墨绿主色，字号 14–15px，不要用框架。
```

**P10 验收与站点**

```
写 tools/verify.mjs：对着已启动的服务跑 27 项检查（健康、导入、幂等、三种检索、覆盖判定、引用完整性、五步流程、时延、未覆盖识别、薄弱点落库、跨会话读回、手动标记、排序、掌握状态），并用 mysql2 直接查库核对 sj_weakpoints / sj_questions / 物理表列类型与索引类型，输出 evidence/verify-log.txt 与 verify.json，有失败就以非 0 退出。
再写 tools/reset.mjs 复位，README.md / VERIFICATION.md / DESIGN.md / TECHNICAL.md / NOTICE.md，最后把 site/index.html 做成单文件展示页。
```

---

## 3. 每阶段记录模板

复制这张表往下填，一天填一行也行，关键是**能对上 commit**：

| 时间 | 阶段 | 我提的要求（摘要） | Qoder 产出 / 我改了什么 | commit | 证据文件 |
|---|---|---|---|---|---|
| 11-09 20:00 | P1 | 需求拆解，输出功能清单与数据模型 | 给了 4 个模块，我补了「导入自检」 | `abc1234` | `docs/qoder/01-plan.png` |
|  | P2 |  |  |  |  |
|  | P3 |  |  |  |  |

建议每次会话结束截三样：**对话框（含提问与关键回答）+ 它改动的文件（diff 或文件树）+ 终端跑通的输出**。单独截对话容易被认为「只是聊天」，三样一起才有说服力。

---

## 4. 发布 Qoder Sites

1. 在 Qoder 里打开本项目，用 Sites 创建站点，根目录指向 `site/`（`site/index.html` 是单文件，图片已内联，不依赖外部资源）；
2. 可见范围选 **「任何人都可访问」**（企业版账号无法设置，必须个人账号）；
3. 发布后用**无痕窗口**打开一次，确认未登录也能看到内容；
4. 把网址填回本文档第 0 节的表格，并把网站里的 `{{UID}}` 换成真实 UID 后重新生成：

```bash
QODER_UID="你的UID" REPO_URL="你的仓库地址" python tools/build_site.py
```

> 注意：站点是纯静态展示页。本项目需要 Node 服务 + seekdb 才能跑，所以网站上写清「在线体验需本地启动」，不要放一个点不动的「立即体验」按钮——评审点开会扣分。

---

## 5. 诚实说明（给自己看的）

- 这份仓库里的代码是你最终要交付的形态，可以作为「目标答案」；但**Qoder 会话必须是真的**——截图里要有你当时的提问、它的回答、它改的文件。
- 不要把时间戳改成连续几分钟一次，评审会看 commit 时间和对话时间是否自洽。
- 如果某一步 Qoder 没做对、你手动改了，就在记录里写「它写成了 X，我改成 Y，原因是 Z」——这种记录比一路顺利更有说服力。
- 网站、仓库、UID 三者要能互相对应：站点由该 UID 的账号发布，仓库的 commit 时间落在开发区间内。
