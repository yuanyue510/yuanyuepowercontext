# P1 阶段产出 · 需求拆解与数据模型

> 这是 P1 的**参考产出**，用来对照 Qoder 给出方案的完整度：Qoder 的版本可能条目顺序不同、命名不同，只要覆盖到这四块（功能、模型、选型、验收）就算达标；差异本身也值得记进开发记录。
> 最终实现与本文的偏差见 `DESIGN.md`「没做什么」一节。

---

## 1. 要解决的痛点

| 痛点 | 现状 | 本项目怎么解 |
|---|---|---|
| 复习时找不到原句 | 笔记散在几十个 md 里，靠肉眼翻或全文搜关键词，说法一变就搜不到 | 向量 + 全文混合检索，按语义和字面同时召回，返回原段落而不是改写过的句子 |
| 通用大模型口径不对 | 答得顺，但结论来自模型参数，和教材/讲义对不上，没法复习 | **不生成，只抽取**：答案由检索命中的段落拼装，每句带 `[n]` 指回原文 |
| 忘了卡在哪 | 当时没懂的概念，事后想不起是哪个、也没记录 | 检索覆盖率低时自动落一条薄弱点，跨会话保留，按「问得多、错得多」排序复习 |

## 2. 功能清单（按用户操作顺序）

1. **建资料集**：新建/切换/删除，一个资料集对应一组同主题资料；同名幂等。
2. **导入资料**：粘贴文本或选文件（md/txt），切片→向量化→写库→刷新索引→**导入自检**（用最后一片的正文反查自己）。
3. **提问**：选模式（hybrid / vector / fulltext）与 TopK，得到答案 + 每条结论的 `[n]` 出处 + 命中片段（可展开看原文）。
4. **判定覆盖**：答案开头区分「资料里有」与「资料里没有正面讲到」两种情况，后者不硬编。
5. **记薄弱点**：未覆盖的问题自动落库；也可手动点「没懂」。
6. **复习**：清单按 misses/asks 排序，可标「懂了」（→ mastered）或「还是不懂」（计数 +1），可导出 Markdown。
7. **换会话仍生效**：记忆在库里，不在浏览器里。

## 3. 数据模型

### 3.1 文档侧（seekdb 集合，一个资料集一张表）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | VARCHAR | `文件名#001`，重复导入幂等 |
| `document` | TEXT + ngram2 全文索引 | 片段正文，供字面召回 |
| `embedding` | VECTOR(512) + HNSW(cosine, M=16, efC=200, efS=128) | bge-small-zh-v1.5 INT8 输出，供语义召回 |
| `metadata` | JSON | `{source, chunk, chars}`，界面上显示来源 |

检索走 `DBMS_HYBRID_SEARCH`，向量与全文两路各取 40，RRF(k=60) **在库内融合**，应用层不做二次拼合。

### 3.2 记忆侧（seekdb 普通表，SQL 访问）

| 表 | 关键字段 | 唯一约束 / 索引 |
|---|---|---|
| `sj_learners` | `learner`, `created_at` | PK `learner` |
| `sj_questions` | `learner`, `collection`, `question`, `covered`, `top_score`, `hits`, `created_at` | 索引 `(learner, created_at)` |
| `sj_weakpoints` | `learner`, `collection`, `concept`, `asks`, `misses`, `status`, `last_score`, `updated_at` | UNIQUE `(learner, collection, concept)` |
| `sj_reviews` | `weak_id`, `result`, `created_at` | 索引 `weak_id` |

状态机：`open`（默认）→ `mastered`（标「懂了」）；`open` 下每次「还是不懂」`misses+1`。

### 3.3 资料集名映射

seekdb 集合名只允许 `[a-zA-Z0-9_]`，中文标签用 `sha256(标签)[:10]` 映射成 `c_<hash>`，标签与集合的对应关系存在 `sj_collections`。

## 4. 技术选型理由

| 选择 | 理由 | 放弃的方案 |
|---|---|---|
| seekdb 做检索 | 同一实例里既有向量+全文混合检索，又有事务型表存记忆，不用维护两套存储 | 单用 SQLite + faiss：要自己实现 RRF，且记忆与文档分离 |
| 本地 bge-small-zh-v1.5 (INT8 23MB) | 离线可跑、无需 API Key、512 维足够中文短片段；Node 进程内推理，26 ms/2 条 | 云端 embedding：引入 Key 与网络依赖，评审环境不可控 |
| 抽取式答案 | 每句可回溯原文，复习场景要的是「书上原话」而不是「模型转述」 | LLM 生成：无法核对，且与赛题「不联网」冲突 |
| 覆盖率判「未覆盖」 | bge 余弦对无关中文片段也能到 0.9+，相似度不可用于该判断 | 相似度阈值：实测不可分 |
| 前端零构建 | `npm start` 就能用，评审不需要装前端工具链 | React/Vite：多一层构建，收益为零 |

## 5. 目录结构

```
server/   config db embed chunk qa index   （接口 + 检索 + 记忆）
public/   index.html styles.css app.js     （单页，零构建）
data/seed/ 6 篇演示资料
scripts/  seed.mjs  fetch-models.mjs
tools/    verify.mjs  reset.mjs  build_site.py  shots.py
site/     template.html → index.html       （Qoder Sites 用的单文件展示页）
docs/     设计、技术、验证、Qoder 开发记录
```

## 6. 验收点（P10 要逐条过）

1. 空库启动自动建库建表，`/api/health` 返回 seekdb 版本；
2. 导入 6 篇 → 33 片段，重复导入片段数不变（幂等）；
3. 三种检索模式都能返回，top1 落在预期文档；
4. 答案里每个 `[n]` 都能在返回的片段里找到对应项；
5. 「缺页中断的处理流程」能答出五步；「React useEffect 怎么写」判为未覆盖；
6. 未覆盖的问题在 `sj_weakpoints` 里有一行，换会话 `GET /api/memory` 仍能读到；
7. 标「懂了」后 `status=mastered`，复习清单排序符合 `misses DESC, asks DESC`；
8. 直接连库能查到 `VECTOR(512)` 列与 `FULLTEXT + VECTOR` 索引；
9. 27 项检查全过，失败时脚本以非 0 退出。
