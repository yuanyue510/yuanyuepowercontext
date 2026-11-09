# 技术说明

## 1. 总体结构

```
浏览器（public/，原生 ES Module）
   │  HTTP / JSON
   ▼
Express 服务（server/index.mjs，:8790）
   ├─ server/embed.mjs   bge-small-zh-v1.5 INT8 → 512 维向量（进程内 ONNX 推理）
   ├─ server/chunk.mjs   中文切片（320 字 / 重叠 60 / 段落优先）
   ├─ server/qa.mjs      抽取式答案（查询词 × 稀有度）
   └─ server/db.mjs      seekdb 双通道
        ├─ 集合接口：文档 + 向量 + 全文索引（SDK）
        └─ SQL：记忆四表（mysql2 连接池）
```

服务进程内只有两个外部依赖：seekdb（数据）与本地 ONNX 模型（向量化）。**不访问任何云端推理或 embedding 接口**，断网也能跑。

## 2. 向量化

| 项 | 内容 |
|---|---|
| 模型 | `bge-small-zh-v1.5`（BAAI，MIT），4 层 BERT，hidden 512，输出 512 维 |
| 权重 | Transformers.js 官方转换版 `Xenova/bge-small-zh-v1.5` 的 `model_quantized.onnx`（INT8 动态量化），23 MB |
| 运行时 | `@huggingface/transformers@3.7`，Node 侧走 onnxruntime-node，CPU 推理 |
| 池化 | `pooling: 'cls'` + `normalize: true`（bge 官方推荐） |
| 查询前缀 | `为这个句子生成表示以用于检索相关文章：`，仅查询侧添加，文档侧不加 |
| 批量 | 默认 8 条一批，可用 `EMBED_BATCH` 调整 |
| 冷启动 | 加载 + 预热一次推理约 200 ms（实测 235 ms），之后单条查询向量化 14–37 ms |

选 INT8 而不是 FP32：模型从 90.5 MB 降到 23 MB，`npm run fetch-models` 下载更快，CPU 推理也更快；本项目语料规模下精度足够（32 个 2-gram 词级别的检索任务，未见明显退化）。

## 3. seekdb 使用

### 3.1 部署与连接

- 实测：CentOS 7 虚拟机原生安装 seekdb 1.4.0（`systemctl start seekdb`，监听 2881），宿主机通过 `SEEKDB_HOST` 直连。
- 兼容 MySQL 协议：`mysql2` 连接池直接执行 SQL；集合相关操作走官方 `seekdb` SDK（`SeekdbClient` / `AdminClient`）。
- 首次启动自动 `CREATE DATABASE shijuan`，并建四张记忆表（`CREATE TABLE IF NOT EXISTS`）。

### 3.2 文档集合

每个资料集一张集合表，由 SDK 创建：

| 列 | 类型 | 说明 |
|---|---|---|
| `_id` | varbinary | 片段 id，形如 `02-操作系统-虚拟内存_md#002`（文件名 + 序号，重复导入幂等） |
| `document` | string | 片段原文 |
| `embedding` | `VECTOR(512)` | HNSW 索引，cosine，M=16 / efConstruction=200 / efSearch=128 |
| `metadata` | json | `{source, chunk, chars}` |

索引实测：`BTREE(PRIMARY) + FULLTEXT(idx_fts) + VECTOR(idx_vec)`，全文用 ngram2（2–3 字切分，适配中文）。

> SDK 会把集合映射成物理表 `c$v2$<collection_id>`，映射关系登记在 `sdk_collections`。验收脚本据此直接查物理表结构，证明向量列与索引真实存在。

### 3.3 混合检索

```js
col.hybridSearch({
  query: { whereDocument: { $contains: queryText }, nResults: 40 },   // 全文路
  knn:   { queryEmbeddings: embedding, nResults: 40 },                // 向量路
  rank:  { rrf: { rankWindowSize: 40, rankConstant: 60 } },           // 库内融合
  nResults: 8
})
```

融合由 seekdb 的 `DBMS_HYBRID_SEARCH` 完成，客户端只提交查询原文与查询向量，不接收两路中间结果、不在本地排序。这一点是「seekdb 真的在起作用」与「装个驱动然后把检索写在应用层」的分界。

### 3.4 记忆四表

```sql
sj_learners(id PK, name, created_at, last_seen)
sj_questions(id PK, learner, collection, question, mode, top_score, hit_count, created_at)
sj_weakpoints(id PK, learner, collection, concept, question, evidence,
              asks, misses, status, last_score, created_at, updated_at,
              UNIQUE KEY (learner, collection, concept))
sj_reviews(id PK, weak_id, result, created_at)
```

写入用 `INSERT ... ON DUPLICATE KEY UPDATE`：同一概念重复提问只累加 `asks`，标记「没懂」累加 `misses` 并把 `status` 拉回 `open`。复习队列是 `ORDER BY misses DESC, asks DESC, updated_at DESC`。

## 4. 答案生成

1. 把每个命中片段按空行切段；标题丢弃；以冒号结尾的引导句与紧随其后的列表合并成一段（否则只答「分五步：」）。
2. 查询按中文 2-gram + 英文/数字 token 切词，过滤停用词。
3. 权重 `log(1 + 段落总数 / (1 + df))`，再乘名次权重 `1/(1+rank*0.4)` 与长段落惩罚。
4. 要求命中 ≥2 词、与已选段落重合度 <0.45、第二条与第一条同源。
5. 输出 `- 段落… [n]`，`n` 是命中片段序号，与前端片段列表一一对应。

覆盖率 = 查询词在全部命中片段中出现的比例，≥0.34 判为「已覆盖」。低于阈值时，答案开头明说「资料里没有正面讲到」，并自动写一条薄弱点。

## 5. 性能

测试条件：Windows 11 / i7-12700H / Node 22.22.2 / seekdb 1.4.0（虚拟机 server 模式）/ 6 篇 33 片段。

| 环节 | 耗时 |
|---|---|
| 导入：切片 | < 1 ms |
| 导入：向量化（33 片） | 1155–1800 ms（约 18–28 片/秒） |
| 导入：写入 | 231–297 ms |
| 导入：refresh_index | 316–628 ms |
| 导入：自检检索 | 32–82 ms |
| 导入：合计 | 1.7–3.1 s |
| 检索：hybrid / vector / fulltext | 10–20 / 5–7 / 8–19 ms |
| 提问端到端 | 38–107 ms |
| 模型加载 | ≈235 ms |

瓶颈在向量化（CPU 推理），检索本身是毫秒级。语料再大时，导入会线性变慢，但检索延迟基本不变（HNSW 对数复杂度）。

## 6. 工程细节

- **连接池**：记忆 SQL 用 `mysql2` 连接池（4 连接 + keepAlive），避免 seekdb 回收空闲连接后出现 `Can't add new command when connection is in closed state`。
- **集合名映射**：seekdb 集合名只允许 `[a-zA-Z0-9_]`，中文名经 `sha256(label)[:10]` 映射为 `sj_c_xxx`，标签存 `sj_collections`，重装后 slug 不变。
- **导入幂等**：片段 id 由「文件名 + 序号」决定，重复导入走 `upsert` 覆盖，不会产生重复行（验收脚本会检查片段总数不变）。
- **导入自检**：写完 `refresh_index()` 后立即用最后一片的正文做一次检索，命中才返回成功。
- **错误处理**：`/api/*` 统一返回 `{ok:false, code, message}`；前端 toast 提示，不吞异常。

## 7. 已知限制

见 `README.md` §七。核心三条：纯抽取式答案表达生硬；覆盖率判定是启发式；只支持纯文本。
