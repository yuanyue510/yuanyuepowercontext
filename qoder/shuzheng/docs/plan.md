# 教材口径复习助手（暂定名：书证 / Shuzheng）— 方案规划

> 一句话定位：把你自己的教材/PPT/讲义变成**可精确到原句**的检索与问答底座；答案只由教材原句拼装，
> 找不到原句就明说找不到；并且把你"当时没读懂"的地方记成账本，事后帮你找回卡点。

核心取舍（贯穿全文）：**不调用任何大模型**，因此系统不生成自由文本，
而是「检索 + 抽取 + 溯源」——证据卡式的确定性答案。这恰好是三个痛点的正解：
原句可定位、口径只来自教材、卡点可回溯。

---

## 一、功能清单（按用户实际操作顺序）

> **范围冻结（M1 主线）**：只做 F1–F5 + F7/F8（导入、检索、证据卡、无证据判定、卡点与复习清单）。
> **F6 口径体检、F9 沉淀导出、F10 管理面板 = 可选扩展，暂不实现**，文档与界面里一律标注"可选/未实现"，不承诺没做的东西。
> F10 只保留一条必需的最小项：启动时 `/api/health` 自检（seekdb 连通、模型在位、无云端调用），因为它支撑验收，不单独做成面板。
> 范围不再扩大。


### F1. 导入资料（第一次进入 / 新增教材）
- F1.1 输入方式：拖拽或选择本地文件（`.md` `.txt` `.html`；PDF 为 F 级可选）、直接粘贴文本、按目录批量导入。
- F1.2 指定资料集属性：教材中文名、学科、版本/年份、"权威级别"（教材 / 讲义 / 习题答案 / 个人笔记）。
  权威级别用于冲突消歧：同一术语不同说法时，教材优先。
- F1.3 切分设置：章节识别规则（标题行正则 / Markdown 层级 / 空段）、句子切分（中英文标点 + 行内公式不切断）。
- F1.4 入库流水线（可看进度、可中断）：解析 → 章节树 → 句级切片 → 本地 ONNX 向量化（512 维）→ 批量写 seekdb。
  **写完不等于可检索**：实测向量通道有可见性延迟（T+0s 只召回全文命中句，约 5s 后向量结果才出现），
  所以入库后要过一道"就绪门槛"（轮询校验查询直到向量通道召回齐全，或超时报错），就绪前资料集状态停在 `importing`。
- F1.5 失败可见：解析失败/向量化失败的行给出行号与原因，绝不静默丢句。
- F1.6 集合名映射：中文名自动生成 ASCII 集合名（`sh_ds_<slug>_<hash8>`）并登记；用户始终只看到中文名。

### F2. 校对切片与出处（导入后立刻做一次）
- F2.1 切片预览：原句卡片列表，显示"页/节 + 字符偏移 + 原文上下文"，点一下跳到原文视图。
- F2.2 手工修补：合并被误切的相邻句、拆开粘连句、修正错位的出处锚点（保留原偏移，修订记录另存）。
- F2.3 抽查工具：随机抽 20 句做"偏移正确性"核对，一键标记通过 → 该资料集解锁检索。

### F3. 建口径（术语与用词基线）
- F3.1 术语抽取（纯统计，离线）：n-gram + 左邻右字 + 教材内频次/覆盖章节数打分，产出候选术语表。
- F3.2 人工确认：勾掉噪声项、补别名（如"牛顿第二定律 = N2L"），每个术语绑定教材内的**定义原句**。
- F3.3 口径规则开关：是否"仅允许教材用词作答""无证据是否拒答（默认拒答）""跨资料集是否禁止混用（默认禁止）"。

### F4. 提问 / 检索（日常主入口）
- F4.1 单资料集检索（默认，口径最严）或跨资料集检索（明确标注来自哪本）。
- F4.2 输入形态：自然语言问句、只丢一个术语、贴一段话问"这话在我教材哪出现过"。
- F4.3 结果 = 证据卡列表，每张卡含：
  - 教材原句（命中词高亮，ngram2 全文命中 + 语义相近双通道）
  - 出处路径（书 → 章 → 小节 → 页/段落 → 句序号）+ 跳转链接
  - 命中理由（全文命中了哪些词、向量相似度多少、库内融合名次）
  - 上下文窗口（同节 ±2 句可展开，避免"断章取义"式碎片）
- F4.4 筛选与再限定：按章节/权威级别/是否含公式收敛结果。
- F4.5 空结果要说人话：给出"教材里没有出现这个说法，最接近的是 X"，而不是硬凑答案。

### F5. 看答案（抽取式，逐句挂证据）
- F5.1 答案 = Top 若干证据句按"与问句的术语重叠 + 库内名次"重排后拼装，**每个句子级引用可点回原文**。
- F5.2 答案头部标注：依据的资料集与版本、证据句数、置信状态（充分 / 单薄 / 无依据）。
- F5.3 数字/单位对齐：同一术语在教材不同处的数值若不一致，主动提示"教材 P32 与 P117 数值不同"（复习高频考点）。
- F5.4 无证据即拒答（**判定规则定死，不用分数阈值**）：
  - 检索分数（`distances`）**只用于排序，不参与任何判定**。实测它是全文+向量的融合名次分，
    量纲随关键词命中数变化、无上界，跨查询不可比；且 bge 对语义无关的中文句子相似度常在 0.9 以上，
    任何"相似度低于 X 就判未覆盖"的阈值法必然误判。
  - 判「资料没讲到」用两条**可解释规则，同时成立才判未覆盖**：
    - ① 查询关键词在命中句里的**覆盖率 < 0.34**（覆盖率 = 命中的不同查询词数 / 查询词总数）；
    - ② 命中结果中**没有一句同时包含 ≥ 2 个查询词**。
  - 依据：两条都成立意味着"召回的句子既没有共同话题词、也没有任何一句同时提到两个关键词"，
    即字面上确实没讲到；只要有一句同时命中两个查询词，就宁可给出证据卡让用户自己判断，不判未覆盖。
  - 不给任何无出处的内容——这是本项目的核心卖点。

### F6. 口径体检（把外部答案拉回教材口径）— **可选扩展，M1 暂不实现**
- F6.1 粘贴任意文本（同学的答案、通用大模型的回答、教辅解析）→ 逐句拆断言。
- F6.2 每个断言回教材做混合检索，三色标注：
  - 绿：教材有对应原句（给出引用）
  - 黄：术语/用词与教材口径不一致（术语表比对，给出教材用词）
  - 红：教材中找不到依据（疑似超纲/口径外/记忆错误）
- F6.3 输出一份"口径 diff 报告"，可复制给同学或存进笔记。

### F7. 标记卡点（读到不懂处，一次点击）
> **M1 已实现最小项**：F5.4 判为未覆盖时自动落两处——`sh_stuck` 集合（一次拒答一条流水，复用检索时算好的查询向量，
> 带判据字段与最近证据 id）与 `sh_review` 关系表（按 (资料集, 问题) 去重的复习队列，见 F8）。
> 并开 `GET /api/stuck` 只读清单用来证明数据真在库里。
> 手工标记（F7.1 的点击入口）、自动关联（F7.2）与补记（F7.3）仍属可选扩展。
- F7.1 在原文视图或证据卡上点"这里我没读懂" → 记录：卡点原句、**当时写下的疑问原文**、当时的时间/学习会话。
- F7.2 卡点自动关联：同术语的其他句、后续章节里可能解释它的句子（"也许 P118 把它讲透了"）。
- F7.3 支持给卡点补一句"现在懂了吗"，形成前后对照。

### F8. 卡点复习（找回当时卡在哪）
> **M1 已实现最小闭环（P6）**：`GET /api/review?dataset=&limit=` 出队（只列 open/reviewing，按 `miss_count DESC, last_seen ASC`），
> `POST /api/review/:id/state` 走 `open→reviewing→mastered` 与回退 open，前端「卡点复习」标签页三个按钮点击后局部刷新。
> 并发安全靠**一条带前驱守卫的 `UPDATE ... WHERE id=? AND status IN (前驱)`**，以 `affectedRows` 为裁决，
> 不采用"先读状态再写"。间隔重复的到期算法（F8.2）与"疑似已解"提醒（F8.3）仍属可选扩展。
- F8.1 卡点账本：按教材/章节/术语聚合，显示卡点数量、悬置时长、状态（未解 / 疑似已解 / 已解）。
  → 已实现最小项：状态取 `open / reviewing / mastered`，错次 `miss_count` 与首次/最近时间都在 `sh_review`。
- F8.2 今日复习队列：离线间隔重复规则（到期优先 + 悬置最久加权 + 同术语聚簇），不依赖任何外部服务。
  → 已实现最小项：错次优先 + 最久未碰优先；`next_review_at` 到期算法未做。
- F8.3 "疑似已解"提醒：卡点关联句被后续复习命中过，则提示可关闭。
- F8.4 复习打点：看到 / 还想不通 / 已解决；打点回写，影响下次排队。→ 已实现（三按钮即三种打点）。

### F9. 沉淀与导出 — **可选扩展，M1 暂不实现**
- F9.1 把一次检索的证据卡 + 答案 + 出处导出为 Markdown（可直接贴进笔记），全程本地写文件。
- F9.2 卡点账本导出为复习清单。
- F9.3 历史提问与查询日志（本地），支持"我这学期问过什么、哪本教材被用得最多"。

### F10. 管理与可观测 — **M1 只做 F10.3 启动自检，其余为可选扩展暂不实现**
- F10.1 资料集管理：改名（中文名，映射表同步）、重建索引、删除。
- F10.2 索引状态面板：seekdb 连接与集合清单、chunk 总数、向量维度（固定 512）、全文索引配置（ngram2, 2–3）、最近入库耗时。
- F10.3 离线自检：一键验证"没有任何云端调用"（模型加载来源=本地 onnx，embeddingFunction 必须为 null）。

---

## 二、数据模型

### 2.1 总体：一张注册表 + 每资料集一个检索集合 + 若干账本集合

```
seekdb 数据库（server 模式：SEEKDB_HOST:2881, user, password, database=shijuan）
├─ sh_registry              资料集注册表（关系表，含中文名的 ASCII 集合名映射）
├─ sh_review                复习队列（关系表，P6：状态机 + 错次，一条 UPDATE ... WHERE 保并发）
├─ sh_ds_<slug>_<hash8>     【核心】原句级切片 + 向量 + 全文（每资料集一个，天然口径隔离）
├─ sh_term_<slug>_<hash8>   术语表（教材口径基线，绑定定义句）
├─ sh_stuck                 卡点流水（全局集合，一次拒答一条，带查询向量）
├─ sh_stuck_link            卡点 ↔ 解释句 关联
├─ sh_query_log             提问/检索日志（全局）
└─ sh_patch_log             人工修补记录（切片合并/拆分/锚点修正）
```

> **共享库纪律**：`shijuan` 库里已有其他项目的 `sj_` 前缀表（`sj_learners / sj_questions / sj_reviews / sj_weakpoints / sj_collections`）。
> 本项目所有表与集合统一 `sh_` 前缀，**任何脚本不得 DROP 非 `sh_` 对象**（`scripts/smoke-seekdb.mjs` 已按此实现：先 `SHOW TABLES` 只读确认，再只创建/复用 `sh_` 集合）。

分资料集建集合的理由：混合检索天然不跨教材串味，符合"按教材口径回答"；跨集检索在服务端并行发起、按权威级别合并展示。

### 2.2 集合 schema（按 v1.4.x SDK 写法，向量自算、`embeddingFunction: null`）

```js
const schema = new Schema({
  fulltextIndex: new FulltextIndexConfig("ngram2", { min_ngram_size: 2, max_ngram_size: 3 }),
  vectorIndex:   new VectorIndexConfig({ hnsw: { dimension: 512, distance: "cosine" } })
});
await client.createCollection({ name: `chunk_${asciiName}`, schema, dimension: 512, embeddingFunction: null });
```

维度 512 全库固定（= `models/bge-small-zh-v1.5` 输出），不匹配即入库失败，不做截断或补零。

### 2.3 `ds_registry`（映射中文资料集名 → ASCII 集合名）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string (pk) | `reg_<hash>` |
| display_name | text | 用户可见中文名（允许中文，只出现在这里） |
| collection_ascii | string | 实际集合名，仅 `[a-zA-Z0-9_]`，规则 `sh_ds_<拼音或en_slug>_<sha1前8位>` |
| subject / edition | text | 学科 / 版本年份 |
| authority | int | 权威级别：1 教材 2 讲义 3 习题答案 4 个人笔记（冲突消歧优先级） |
| doc_count / chunk_count | int | 统计 |
| status | string | `importing / needs_review / ready / failed`（未通过 F2 抽查 → 不进检索） |
| embed_model | string | 固定 `bge-small-zh-v1.5-onnx-quant`（换模型需重建，字段用于校验一致性） |
| created_at / updated_at | datetime | |

唯一约束：`display_name`、`collection_ascii` 各唯一；重名追加 `__v2` 并保留历史。

### 2.4 `sh_ds_*`（核心集合：一条文档 = 一个句级切片）

**两条切分硬规则（已定稿）**
- R1 短句合并：单句正文 **少于 15 字**时并入相邻句（优先向前并），否则全文检索噪声大、ngram 片段无意义。
- R2 每个 chunk 同时保存**正文**与**所属小节标题**：检索命中后「资料名 / 小节 / 原句」三者一起返回，
  且小节标题参与全文命中（搜"牛顿第二定律"能召回该节下的句子）。
  落地：`text` = 纯原句（offset、高亮、展示均以它为准）；`index_text` = `小节标题 + 原句`（作为 seekdb 的 documents 字段入库）。

文档主体：`id` / `text`（=原句正文，展示与定位用）/ `index_text`（=小节标题+原句，全文索引字段）
/ `embedding`（512 float，HNSW cosine）/ `metadata`：

| 字段 | 类型 | 索引/用途 | 说明 |
|---|---|---|---|
| dataset_id | string | 过滤 | 所属资料集（=registry.id） |
| doc_id | string | 过滤/聚合 | 一份文件 = 一个 doc |
| dataset_name | text | **返回** | 资料名（中文，直接给前端展示） |
| section_title | text | **返回** | 所属小节标题 |
| section_path | text | 展示 | 「第3章 动力学 > 3.2 牛顿第二定律」面包屑 |
| section_id | string | 过滤 | 章节锚点，用于上下文窗口扩展 |
| sent_no_in_section | int | 排序 | 句序号，展开 ±2 句靠它 |
| merged_sent_count | int | 校对 | R1 合并了几句（1 = 未合并） |
| char_start / char_end | int | **原句定位** | 在规范化全文中的字符偏移，跳转与高亮的依据 |
| page / para | int? | 展示 | 教材页码/段落号（PDF/手写标注可得，可空） |
| source_uri | text | 溯源 | 原始文件相对路径 |
| text_raw | text | 校对 | 未规范化的原始句（保留空格/断行差异） |
| has_formula | bool | 过滤 | 是否含公式（`$...$`/`\frac`/数字运算符密度判定） |
| formula_keys | text | 术语联动 | 抽取出的公式标识（如 `F=ma`） |
| term_ids | text(json) | 口径联动 | 命中的术语 id 列表 |
| lang | string | 过滤 | `zh / en / mixed` |
| norm_len | int | 重排 | 归一化字符数（避免长句天然占便宜） |
| created_at | datetime | | |

> 原文全文另存为 `data/normalized/<doc_id>.txt`（由服务端读取做 offset 高亮），
> 数据库只存切片与 offset，避免把整本书塞进一条文档。
> 注：SDK 侧过滤能力有限（见第三节），`lang/has_formula` 等收敛在返回结果后服务端二次过滤。


### 2.5 `sh_term_*`（术语/口径基线）

| 字段 | 类型 | 说明 |
|---|---|---|
| id / term | string / text | 术语本体，全文索引 |
| aliases | json | 别名数组（英文缩写、口语说法） |
| definition_sent_ids | json | 教材内定义句 id 列表（口径出处） |
| freq / section_coverage | int | 统计分数来源（F3.1） |
| confirmed | bool | 人工确认后才进入口径校验 |
| embedding | 512 | 术语也向量化，供 F6 近似匹配 |

### 2.6 `sh_stuck`（卡点账本，全局集合）

| 字段 | 类型 | 说明 |
|---|---|---|
| chunk_id / dataset_id / section_path | string/text | 卡在教材哪一句 |
| question_text | text | **当时写下的疑问原文**（全文索引 + 向量，可再检索回来） |
| state | string | `open / suspected_resolved / resolved` |
| created_at / last_review_at / next_review_at | datetime | 间隔重复调度 |
| ease / reps / lapse_count | int | 简化版间隔重复参数（离线规则，无外部服务） |
| resolved_by_chunk_id | string? | 因哪一句判定"疑似已解" |
| now_note | text? | F7.3 "现在懂了/还是不懂"的补记 |

### 2.6b `sh_review`（复习队列，关系表，P6 已实现）

`sh_stuck` 是流水（同一问题问三次就是三条），`sh_review` 是队列（同一问题永远一行）。
队列要能被条件更新（`status`/`miss_count`），所以放关系表而不是集合。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | VARCHAR(64) pk | `rv_` + sha1(`资料集名::问题原文`) 前 16 位：**确定性**，重复拒答走 `ON DUPLICATE KEY UPDATE` |
| dataset_name / question_text | VARCHAR | 卡点身份的两个组成部分，也是原问题展示 |
| concept | VARCHAR(300) | 「概念」= 未命中的查询词（资料没证到的那个说法），全命中时退回全部查询词 |
| coverage / missed_terms | DOUBLE / VARCHAR | 判据数值留档，复习时能看到当时覆盖率多少 |
| nearest_doc_id | VARCHAR(100) | 最近证据所在资料集文档（取字面最接近那条切片的 `doc_id`） |
| latest_stuck_id | VARCHAR(64) | 指回 `sh_stuck` 最新一条流水，两边可互相核对 |
| status | VARCHAR(32) | `open / reviewing / mastered`，只允许 `open→reviewing→mastered` 与回退 `open` |
| miss_count | INT | 错次：同一问题被判未覆盖的次数，队列第一排序键 |
| first_seen / last_seen | BIGINT | 首次/最近出现（ms）。`last_seen ASC` 是第二排序键：错得一样多，久没碰的先看 |
| status_changed_at | BIGINT | 每次成功流转都写，`UPDATE` 的 SET 里 |
| mastered_at | BIGINT | 进入 mastered 时写，回退 open 时清空（保持与 status 自洽） |

建表用 `CREATE TABLE IF NOT EXISTS`，全项目不 DROP 任何表；读写走独立 mysql2 连接池（原因见「已确认事实 18」）。

### 2.7 `sh_stuck_link` / `sh_query_log` / `sh_patch_log`

- `stuck_link`：`stuck_id, chunk_id, relation(explains|contradict|same_term), score`。
- `query_log`：`q_text, mode(hybrid|fulltext|vector|caliber), dataset_ids, result_ids, top_scores, fused_rank, latency_ms, picked_chunk_id(用户最终点了哪句), ts` —— 检索质量评估与"我这学期问过什么"都靠它。
- `patch_log`：`chunk_id, op(merge|split|reanchor), before, after, ts` —— 保留可回滚的修补历史，原 offset 不被覆盖。

### 2.8 检索接口用法（库内融合，不自己实现 RRF）

```js
await collection.hybridSearch({
  query: { whereDocument: { $contains: keyword } },   // 全文通道：ngram2 关键词
  knn:   { queryEmbeddings: [queryVec] },             // 语义通道：本地 ONNX 算出的 512 维
  nResults: 8
});
```

- 关键词从问句里离线抽取：术语表命中词 > ngram 高频词 > 原始整句，逐级降级。
- **不做 SDK 层过滤**（已确认：`query` 只有 `queryEmbeddings/queryTexts/nResults`）：
  隔离靠**按资料集分集合**，收敛靠**检索后服务端本地过滤**（结果集只有 8 条，代价可忽略）。
- 多资料集 = 多次 `hybridSearch` 并发，服务端按 `authority` + 分数重排，展示层永远标清出处。
- F6（可选扩展）口径体检：对每条外部断言句重复上述调用，用分数阈值判红/黄/绿。

---

## 三、技术选型理由

| 选择 | 理由 | 放弃的替代方案 |
|---|---|---|
| **seekdb 服务端模式（2881）** | 题面硬约束；一套引擎同时给存储、查询、向量 ANN、中文 ngram 全文与**库内融合**。分资料集 collection 天然做口径隔离。`embeddingFunction: null` + 不装 default-embed/qwen → 零云端调用。 | 自己拼"向量库 + ES + SQLite"（违背约束，融合逻辑还得手写）；SDK 内置向量化（会触网）。 |
| **不装 LLM，答案走抽取式** | 约束是"不能调云端模型"；本机跑不动可靠生成模型；更重要的是生成式天然会串味（口径漂移）。抽取式答案**每句可溯源、不可编造、无证据就拒答**，正中痛点 1、2。 | 本地小模型生成（体积/耗时/幻觉，且难验收"口径一致"）。 |
| **`@huggingface/transformers`（transformers.js）加载 tokenizer + ONNX 模型** | 已定稿：**不自研 tokenizer**，直接 `AutoTokenizer.from_pretrained('models/bge-small-zh-v1.5')`（目录里 `tokenizer.json` + `config.json` 齐全，且 `onnx/model_quantized.onnx` 正是 transformers.js 的默认文件名）。包内自带 `onnxruntime-node`，所以**不单独声明 onnxruntime 依赖**。量化模型 24 MB、纯 CPU、无 GPU、无需 Python（本机 `python` 只是商店占位符、无 pip、无 docker）；`hidden_size=512` 正好等于 seekdb 固定维度。 | 自研 WordPiece（放弃：多一份需要长期维护的正确性风险）；Python 服务（本机无解释器）；seekdb `default-embed`/qwen 插件（违背零云端约束，且其发布清单带 `workspace:*` 会让 `npm i` 直接失败）。 |
| **Node 单体后端（`server/`，`npm start` 一条命令）** | 约束 3。入库、向量化、检索、静态托管全在一个 Node 进程里；seekdb 用 Node SDK，onnxruntime-node 同进程，无跨语言桥。 | 前后端分离 + 独立 worker/队列（比赛场景不需要，多一层运维）。 |
| **前端零构建：原生 ES Module + 手写轻量渲染** | 约束 3：无打包器、无 `dist`、改文件刷新即生效；`public/` 直出。UI 就三个视图（检索 / 原文 / 账本），框架收益低于成本。 | Vue/React + Vite（违背"零构建"，且引入 node_modules 编译链）。 |
| **切片粒度 = 句级 + 节内上下文窗口扩展** | 痛点 1 要求"定位原句"，句级 chunk 命中即原句；碎片化风险靠检索后按 `section_id + sent_no` 展开 ±2 句补偿（不额外造"段落向量"）。 | 只切 512 字长块（能检索但不能定位原句，offset 还得二次定位，多一层错误）。 |
| **全文 ngram2(2,3) + 术语表关键词抽取** | 复习查询大量是精确术语、公式号、"这一定义在哪"，纯向量容易把不同概念的近义句混进来；两通道互补，融合交给 seekdb。 | 纯向量（术语精度差）；纯全文（同义表述召回差）。 |
| **中文资料集名 → ASCII 集合名 + registry 映射** | 已知约束：集合名只允许 `[a-zA-Z0-9_]`。映射集中在一处，UI 永远显示中文名，重命名只改 registry。 | 拒绝中文名（体验差）；把中文塞进集合名（直接失败）。 |
| **注册表用 seekdb 的关系表（`client.execute` 建 `sh_registry`），切片/账本用集合，规范化全文存 `data/`** | 减少数据源数量：同一个 seekdb 实例既给关系存储又给向量/全文检索，不引第二种引擎。offset 需要稳定文本，落文件最简单。 | 元数据塞 SQLite（多一套引擎与迁移成本）；把整本书正文塞进集合文档（白白向量化一遍长文本）。 |

### 已确认事实与遗留风险（P2 实测，不再靠猜）
1. **过滤能力**：`query` 只有 `queryEmbeddings/queryTexts/nResults`，无 `where`。→ 方案不变：分集合 + 检索后本地过滤。
   （附带事实：`hybridSearch` 的 `query.whereDocument.$contains` 可用；`client.execute(sql, params)` 可跑原生 SQL，
   P5 起用它建 `sh_registry` 关系表——注册表按名字精确查一行，用集合存反而要绕，关系表最直接。仍只有这一张，不扩散。）
2. **写入 API**：`collection.add({ ids, documents, embeddings, metadatas })`，维度需与 `VectorIndexConfig` 一致；
   `client.getCollection({ name })` 取已有集合。
3. **`@seekdb/default-embed` 不能被安装**：它不仅是云端/内置向量化插件（违背约束），其发布清单里
   `peerDependencies` 写的是 `workspace:*`，会让 `npm i` 直接报 `EUNSUPPORTEDPROTOCOL`。
   → 已用 `.npmrc: legacy-peer-deps=true` 关闭自动 peer 安装；`npm i` 现在干净通过，且实测 `node_modules/@seekdb/default-embed` 不存在。
4. **seekdb server 已连通并实测**（`192.168.192.131:2881`，库 `shijuan`，参数走 `.env`，`.env.example` 留 `127.0.0.1` 占位）：
   `createCollection(ngram2 + hnsw 512 cosine, embeddingFunction:null)` → `add` → `get` → `hybridSearch` 全链路通过（`npm run smoke`）。
   嵌入式模式在 Windows 仍不可用（`@seekdb/js-bindings` 只有 `download.js`），所以 server 模式是唯一路径。
5. **中文检索实测**（`npm run probe`，基线集合 `sh_probe_ngram` 保留不动）：
   - `$contains` 对中文短词有效：`"动能"` → 命中该句；`"合外力做功"` → 命中 2 句。
   - **ngram2 确实生效**：跨词边片段 `"重力加"`、`"能定"` 都能召回 → 二元组索引可用。
   - 返回结构只有 `ids / distances / documents / metadatas / embeddings`，**没有 `similarity`**；数组为 `[[...]]` 嵌套。
6. **`distances` 语义已判定（差分测试 `npm run verify:distances`，结论到此为止，不做阈值校准）**：
   固定关键词只换查询向量 → 排序不变、分数小幅变化（1.6416 / 1.5187 / 1.5253）；换关键词 → 分数大幅跳变（命中文本的句子 3.155 vs 基线 0.88）。
   对照纯向量 `query()`：同一查询返回 0.357 / 0.563 这类**有界**的 cosine 距离。
   → 结论：`hybridSearch.distances` 是**融合名次分**（无上界、跨查询不可比），只能用于排序；判定一律走 F5.4 的可解释规则。
7. **`hybridSearch` 是并集融合，不是 AND 过滤**：关键词在教材里完全不存在时仍会返回向量通道的近邻（实测 `洛伦兹力` 返回 3 条），
   所以"未覆盖"不能靠"结果为空"来判断，必须用 F5.4 规则。
8. **写入后向量通道有可见性延迟**：`add` 完立刻查，T+0s 只召回全文命中的 1 条，T+5s 起稳定返回 2 条（`sh_delay_check` 实测，用完已删）。
   → 导入流程必须有"就绪门槛"（见 F1.4），否则用户会遇到"刚导入搜不到"。
9. **`getCollection` 必须显式传 `embeddingFunction: null`**：`embeddingFunction: null` 建出来的集合，
   库内元数据记的是 `default-embed`，若 `getCollection({name})` 不带该参数，SDK 会去 `import('@seekdb/default-embed')` 并抛
   `Embedding function 'default-embed' is not registered`。带上 `embeddingFunction: null` 才走"无 EF"分支——这也顺带保证了不会碰云端。
10. **`get({ ids })` 按表序返回，不保持请求顺序**：需要按名次对齐时必须自己建 id→行 的 Map，不能靠下标配对。
11. **transformers.js 离线加载已跑通**：`env.allowRemoteModels=false` + `env.localModelPath=models/` + `dtype:'q8'`
    （默认 fp32 会去找不存在的 `onnx/model.onnx`）；mean-pool + normalize 输出 512 维、模长 1.000000；
    33 条切片向量化 356 ms；查询侧带 bge 指令前缀后 `什么是牛顿第二定律` 对目标句 cosine 0.357、对无关句 0.563（距离越小越近，排序正确）。
12. **示例语料已端到端跑通**（`node scripts/p4-import-demo.mjs`）：10 小节 → 33 切片（R1 合并 4 条、残留短句 0）→ 写入 `sh_ds_doc_43cbe2d2` → 混合检索命中，
    offset 自检一致。
13. **`hybridSearch` 依赖连接上的会话变量，不能并发**（读 SDK 实现确认，v1.4）：它的流程是
    `SET @search_parm = <json>` → 从系统表读回生成的 `query_sql` → 再执行。同一条 mysql2 连接上并发调用会互相覆盖 `search_parm`，
    返回的是**别人那次**的结果。→ `server/lib/seekdb/client.js` 提供 `exclusive()` 队列，检索与入库全部串行；
    多路关键词召回也必须串行发（P5 的实现方式）。
14. **`query()` / `hybridSearch()` 的 `include` 只裁 documents/metadatas/embeddings，`ids` 与 `distances` 恒定返回**，
    且 `distances` 在纯向量 `query()` 里是有界 cosine、在 `hybridSearch()` 里是融合名次分（同第 6 条）。
    → 就绪门槛用 `include:['metadatas']` 轮询，避免每 200ms 拖一批 512 维向量回来。
15. **offset 不变式必须由构造保证，不能事后 trim**（P5 实测踩到）：R1 合并短句时，若把两句直接拼接，
    句间的 `\n` 就丢了，`normalized.slice(char_start, char_end)` 与存库正文不再相等 —— 4/33 条切片偏移。
    → 现在 `splitSentences` 保证 `text === source.slice(charStart, charEnd)`（首尾空白靠移动偏移量剥掉），
    并把句间空白记进 `gapBefore`，合并时一起接上；`importDataset` 对**全部**切片做逐字自检，不一致直接拒绝放行。
16. **就绪门槛实测有效**（`生物必修1-细胞代谢讲义`，33 条）：第 1 次探测 表行数 33 / 向量通道可召回 **0**，
    第 2 次 33/33，第 3 次读数与上次相同 → 467 ms 放行（间隔 200ms、上限 10s）。
    滞后只在向量通道，表行数一开始就够，所以读数取两者最小值是对的；固定 sleep 短了会漏、长了白等。
17. **多路召回的耗时账**（同一次 `npm run verify:p5`）：单关键词问题 512–705 ms，
    三关键词（4 条通道串行）1179 ms —— 每条通道是一次 DB 往返，且第 13 条决定了它们**不能并发**。
    C.7 的 `P95 ≤ 800 ms` 在 ≤3 条通道时达标；要更快就把 `MAX_KEYWORD_CHANNELS` 降到 3，
    代价是长问句的第三个词不再单独走全文通道。本地向量化只占 ~50 ms（模型常驻后）。
18. **SDK 的 `execute()` 拿不到 affectedRows，写语句必须另开 mysql2 连接**（P6 读实现确认，v1.4 `dist/index.mjs:90-99`）：
    它只在语句以 `SELECT/SHOW/DESCRIBE` 开头时返回行，其它一律 `return null`，`ResultSetHeader` 被丢掉。
    剩下的取行数的路子里，`client._internal.connectionManager.getRawConnection()` 是两层 `@internal` 私有 API（随 SDK 升级会碎），
    所以走 seekdb README 对跨向量/关系写法推荐的那条：**独立 mysql2 连接池**（`server/lib/seekdb/sql.js`）。
    注意 mysql2 的连接串要按 `user@tenant` 拼（`root@sys`），与 SDK 内部 `InternalClient` 的 `fullUser` 对齐，否则连不上。
    `mysql2` 本是 seekdb 的依赖（`^3.11.5`，实测解析到 3.24.6），这里只是把它提为本项目直接依赖，不新增下载。
19. **并发安全靠一条 UPDATE 的 WHERE 守卫 + affectedRows 裁决**（P6 实测）：同一行同时发两次 `open→reviewing`，
    一条连接命中 `status IN ('open')` 返回 200，另一条执行时该行已是 reviewing，守卫不成立 → affectedRows=0 → 409，
    库里 `status_changed_at` 只推进一次。"先 SELECT 判断再 UPDATE" 才是竞态，所以那次后置 SELECT 只用于报错文案。
    附带好处：关系表走连接池，不占检索那条 `exclusive()` 串行队列（复习列表刷新不该排在一次慢检索后面）。

---

## 四、目录结构

```
qoder-dev/
├─ docs/
│  └─ plan.md                        # 本文档
├─ models/
│  └─ bge-small-zh-v1.5/             # 已有：config.json / tokenizer.json / onnx/model_quantized.onnx
├─ server/                           # 唯一 Node 进程，npm start 入口
│  ├─ index.js                       # 静态托管 public/ + 路由挂载 + seekdb 连接自检
│  ├─ config.js                      # 端口/数据目录/模型路径/维度=512 常量
│  ├─ routes/
│  │  ├─ health.js                   # 已实现（F10.3）：端口/SDK/模型在位/无云端调用的启动自检
│  │  ├─ dataset.js                  # 已实现（F1）：POST /import、GET /list、GET /:name/text（原文视图读它）
│  │  ├─ search.js                   # 已实现（F4+F5）：POST /api/search → 证据卡 + 抽取式答案 + 判据
│  │  ├─ stuck.js                    # 最小项已实现（F7 落账的证明）：GET /api/stuck 只读清单
│  │  ├─ review.js                   # 已实现（F8）：GET /api/review?dataset=&limit=、POST /api/review/:id/state
│  │  ├─ term.js                     # F3：术语抽取、口径规则（暂不实现）
│  │  └─ export.js                   # F9：导出 Markdown（可选扩展，暂不实现）
│  ├─ lib/
│  │  ├─ seekdb/
│  │  │  ├─ client.js                # 已实现：SeekdbClient 单例、openCollection(embeddingFunction:null)、exclusive() 串行队列
│  │  │  ├─ collections.js           # 已实现：sh_registry 关系表 DDL/DML + recreateCollection(ngram2+hnsw512)
│  │  │  ├─ sql.js                   # 已实现（P6）：独立 mysql2 连接池，写语句返回 affectedRows（见已确认事实 18）
│  │  │  ├─ ready.js                 # 已实现：就绪门槛（200ms 轮询、连续 2 次读数相同且 ≥ 期望、10s 上限、超时带实际/期望 count）
│  │  │  └─ naming.js                # 已实现：中文名 ↔ sh_ds_[a-zA-Z0-9_] 映射 + assertOwnCollection 前缀护栏
│  │  ├─ embed/
│  │  │  └─ local-embedder.js        # 已实现：transformers.js 离线加载（allowRemoteModels=false + dtype:'q8'）
│  │  │                              #   mean-pool + normalize → 512；embedDocuments / embedQuery(bge 指令前缀)
│  │  ├─ ingest/
│  │  │  ├─ section.js               # 已实现：normalizeText + parseSections（小节标题/面包屑/正文偏移）
│  │  │  ├─ sentence.js              # 已实现：splitSentences（公式内不断句、offset 不变式）+ mergeShortSentences（R1，<15 字，保留 gapBefore）
│  │  │  └─ pipeline.js              # 已实现（F1.4）：offset 全量自检 → 批量向量化 → 重建集合写入 → 就绪门槛 → 登记
│  │  │                              #   注：未拆 parse.{md,txt,html}.js —— md/txt 走同一条路（标题行正则 + 句子切分），
│  │  │                              #   .html 由 normalizeText 内的 htmlToText 先转纯文本（只认真像 HTML 的输入，避免吃掉 `F<30N`），offset 以转换后文本为准
│  │  ├─ answer/
│  │  │  ├─ keywords.js              # 已实现：汉字串 → 剥疑问词 → 主关键词 + 候选词
│  │  │  ├─ coverage.js              # 已实现（F5.4）：两条可解释规则（覆盖率 0.34 + ≥2 查询词同句），输出判据本身
│  │  │  └─ assemble.js              # 已实现（F5）：多路召回（每候选词一条 hybridSearch + 一条纯向量）→ 名次/通道数重排
│  │  │                              #   → 证据卡（资料名/小节/原句/char_start-end）→ 抽取式答案或拒答
│  │  ├─ stuck/ledger.js             # 已实现（最小项）：sh_stuck 缺失才建（同 ngram2+hnsw512 schema）、未覆盖落账 + 同步入复习队列、只读清单
│  │  └─ review/store.js             # 已实现（P6/F8）：sh_review DDL（IF NOT EXISTS）、确定性 id、miss_count 累加、一条 UPDATE...WHERE 状态机
│  │                                 #   注：F8.2 的 next_review_at 到期算法未做，排序只用 miss_count DESC + last_seen ASC
├─ public/                           # 零构建：浏览器直接跑
│  ├─ index.html                     # 已实现：导入 / 检索 / 卡点复习 / 状态
│  ├─ css/app.css
│  └─ js/
│     ├─ app.js                      # 已实现：健康徽标 + 视图装配
│     ├─ api.js                      # 已实现：fetch 封装 + el() 手写 DOM 工具
│     ├─ views/import.js             # 已实现：导入表单 + 入库统计（切片数/R1/offset 自检/就绪耗时/集合名）+ 资料集清单
│     ├─ views/search.js             # 已实现：答案区（置信状态）+ 判据面板 + 证据卡 + 原文定位面板
│     ├─ views/review.js             # 已实现（P6/F8）：待复习列表 + 三按钮（还没懂/在复习/已掌握）+ 点击后局部刷新 + 空态「还没有卡点」
│     └─ ui/{evidence-card,highlight,tabs}.js
│                                    # 已实现：证据卡渲染、命中词加粗、按 char_start–end 高亮并自查偏移
├─ data/                             # 本地落盘（.gitignore）
│  ├─ uploads/                       # 原始文件副本
│  ├─ normalized/<doc_id>.txt        # 规范化全文，offset 高亮读它
│  └─ exports/                       # F9 导出
├─ seekdb-data/                      # seekdb 数据目录（.gitignore 已含）
├─ eval/
│  ├─ corpus/物理必修1-动力学讲义.md  # 已写：示例语料（10 小节，含短句/公式/未覆盖词）
│  ├─ corpus/生物必修1-细胞代谢讲义.md # 已写：第二份语料（9 小节 33 切片），P5 用它验证"换资料不依赖上一批"
│  ├─ queries.jsonl                  # 30 条人工标注查询（gold chunk id）
│  └─ caliber-cases.jsonl            # 可选扩展（F6）用例，暂不使用
├─ scripts/
│  ├─ smoke-seekdb.mjs               # 已跑通：连接→建集合→写 1 条→读回，跑完自删 sh_smoke
│  ├─ probe-seekdb.mjs               # 已跑通：$contains 中文 / ngram2 / 有无 similarity（基线集合 sh_probe_ngram 保留）
│  ├─ verify-distances.mjs           # 已跑通：判定 distances 是融合名次分（结论见第三节第 6 条）
│  ├─ p4-import-demo.mjs             # 已跑通：语料→切片→向量化→写入→混合检索
│  ├─ verify-p5.mjs                  # 已跑通（npm run verify:p5）：走真实 HTTP 链路打印判据/覆盖率/证据卡与"点引用定位到的原句"
│  ├─ probe-affected-rows.mjs        # 已跑通（P6 决策依据）：证明 mysql2 独立连接能拿到 UPDATE 的 affectedRows，只跑零影响语句
│  ├─ show-review.mjs                # 已跑通（npm run show:review）：直查 sh_review 打印状态/错次/时间戳，做流转前后库内对照
│  ├─ verify-offset.mjs              # 待写：抽查 char_start/end → 原文一致性（p4 脚本里已有最小自检）
│  └─ eval-retrieval.mjs             # 待写：Recall@8 / MRR
├─ package.json                      # "start": "node --env-file-if-exists=.env server/index.js"，无 build/dev 脚本
├─ .npmrc                            # legacy-peer-deps=true（避开 default-embed 的 workspace:* peer）
├─ .env                              # 真实 seekdb 连接参数（不进 git）
├─ .env.example                      # 127.0.0.1 占位，供他人 clone 后复制
└─ .gitignore                        # 已含 node_modules/ .env *.log seekdb-data/ data/
```

依赖（P2 已定并安装通过，P6 起共 4 个）：`seekdb@^1.4.0`（MySQL 协议 server 模式）、`express@^4.21`、
`@huggingface/transformers@^3.5.1`（自带 onnxruntime-node，故不再单独声明）、`mysql2@^3.11.5`
（seekdb 自身的依赖，P6 因要读 UPDATE 的 affectedRows 提为直接依赖，见已确认事实 18；不新增下载）。
文件解析仅针对 md/txt/html，用自写少量代码，不引第三方解析库。
**不引入**：`@seekdb/default-embed`、任何模型下载脚本、任何云端 SDK。

---

## 五、验收点

### A. 硬约束（红线，一条不过即不通过）
1. **零云端**：`eval/` 全流程在断网环境跑通；代码静态检查无 `https?://` 出网调用（本地 `localhost` 除外）；
   `createCollection` 全部 `embeddingFunction: null`；依赖树中无向量化插件；`docs` 与启动日志里可看到"离线自检通过"（F10.3）。
2. **seekdb 承担存储与检索**：向量与全文命中、融合均由 `hybridSearch` 返回；
   删除本地缓存文件后重新查询结果一致（证明数据真在库里，不在内存假数据里）。
3. **零构建**：仓库无 `webpack/vite/rollup/esbuild` 配置、无 `dist/`；`npm start` 后直接访问 `http://127.0.0.1:8790` 可用（`curl -s http://127.0.0.1:8790/api/health` 即验收命令）；
   改 `public/js/**` 刷新即生效。安装到可运行 ≤ 3 步（`npm i`（依赖 `.npmrc`，实测一条命令通过）→ seekdb server 可达 → `npm start`）。

### B. 三个痛点各自的量化验收
4. **原句可定位（痛点 1）**
   - 随机抽 50 句：offset → 原文渲染高亮 100% 命中该句，不偏移一个字。
   - 30 条标注查询：`Recall@8 ≥ 0.85`，`MRR ≥ 0.60`；每条命中结果均带完整出处路径（书/章/节/句）。
   - 未覆盖场景 ≥3 条：系统明确回答"教材中未见此说法，最接近 X"，**不输出无出处内容**（0 编造）。
     判定必须走 F5.4 两条规则（覆盖率 < 0.34 且 无任何一句含 ≥2 查询词），**不接受任何基于 `distances` 的阈值**；
     评审可用同一批查询对照：规则的每条判定都能指出"哪个词没出现/哪一句含两个词"。
   - 就绪门槛：导入完成后立刻检索，向量通道结果必须齐全（实测有秒级可见性延迟，未过门槛前资料集不得进入检索）。
   - 切分规则可验证：`< 15 字`的句子不单独成 chunk（R1，抽查 0 例外）；每条命中结果都带齐
     「资料名 / 小节 / 原句」三项（R2），缺一即不通过。
5. **教材口径一致（痛点 2）** — *F6 口径体检为可选扩展，M1 不实现，以下前两条为主线验收*
   - 答案 100% 句子级可点击回原文；不可溯源的句子数 = 0（要么删掉要么标"教材外"）。
   - `eval/caliber-cases.jsonl` 10 条：术语口径错误句召回 ≥ 8/10，无依据句误判率 ≤ 10%（对照人工标注）。
   - 术语表未确认（`confirmed=false`）的资料集，F6 只出提示不出结论，避免统计噪声冒充口径。
6. **卡点可回溯（痛点 3）**
   - 标记 → 重启服务 → 账本完整（数据在 seekdb），卡点原句 + 当时疑问原文可原样找回。
   - 复习队列：构造 10 条不同 `next_review_at` 的卡点，到期项当日 100% 出现在队列且优先级正确；未到期项不出现。
   - "疑似已解"至少 1 条真实链路演示：卡点 → 关联解释句 → 提示可关闭。

### C. 性能与健壮性（目标值，实现期实测替换）
7. 单条查询端到端（含本地向量化）`P95 ≤ 800 ms`；`nResults=8` 下前端渲染不阻塞。
8. 一本约 20 万字教材入库 ≤ 5 分钟，进度条实时更新，中断后可续；入库失败行有行号与原因（F1.5）。
9. 异常可见：seekdb 端口不通 / 模型文件缺失 / 维度不匹配 → 启动或入库时报出可读错误并阻断，不静默降级。
10. 并发安全：同一资料集重复导入不产生重复切片（按 `doc_id + char_start + char_end` 幂等）。

### D. 演示脚本（比赛现场一条线跑完）
11. 导入教材 → 校对抽查 → 建术语口径 → 提问出证据卡 → 点引用跳原文高亮 →
    粘一段通用大模型答案做口径体检（现场看到红/黄）→ 标记一处卡点 → 次日复习队列找回它。
    全程无网络请求（浏览器 Network 面板可佐证），单轮操作 ≤ 3 次点击/输入。
