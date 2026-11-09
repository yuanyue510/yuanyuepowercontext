# 端侧书房 · seekdb 浏览器本地知识库

在浏览器里完成文档向量化（Transformers.js / ONNX Runtime Web，WebGPU 优先、WASM 自动降级，INT8/FP16 量化），把向量、原文与元数据写入 **seekdb**，用 seekdb 的 **DBMS_HYBRID_SEARCH** 完成向量 + 全文混合检索（RRF 融合在数据库内完成）。

> 没有任何云端推理：模型文件由本地服务下发到浏览器，实际计算全部发生在用户设备；服务端只负责静态资源、seekdb 接入与 HTTP 转发，不参与任何向量计算。

## 功能

- **导入语料**：拖入/粘贴 `.txt`/`.md`，浏览器内切片（默认 320 字、重叠 60）→ 浏览器内向量化 → 分批写入 seekdb → `refresh_index()` 刷新索引 → 自动校验新增片段可检索
- **检索**：混合 RRF / 仅向量 / 仅全文三种模式，TopK 可调，展示排序、得分、来源、片段与原文
- **知识库管理**：多集合创建/切换/删除，集合与会话状态持久化（localStorage），增量导入幂等（upsert）
- **后端提示**：顶栏徽章实时显示 `WebGPU · FP16` 或 `WASM · INT8`，不支持 WebGPU 时自动降级并在悬浮提示中说明
- **诊断面板**：推理后端、模型体积与压缩比、分阶段耗时（模型加载/向量化/写入/索引刷新/查询向量化/检索/端到端）
- **评测面板**：同一评测集上对比 FP32 / FP16 / INT8 的 Recall@5、nDCG@10、MRR 与检索延迟

## 运行

### 0. 环境要求

- Node.js ≥ 20
- Chrome / Edge 最新版（WebGPU 需要 Chrome 121+；旧浏览器自动降级 WASM，功能不受影响）
- Docker（用于一键启动 seekdb），或任一可连接的 seekdb 实例

### 1. 启动 seekdb

```bash
docker compose up -d          # 等价于 docker run -d -p 2881:2881 oceanbase/seekdb
# 数据目录挂载在 ./seekdb-data；root 密码默认为空
```

已有 seekdb 实例时跳过此步，改用 `SEEKDB_HOST/SEEKDB_PORT` 指向即可（默认 127.0.0.1:2881，root / 空密码）。

### 2. 安装依赖与模型

```bash
npm install
npm run fetch-models          # 下载 bge-small-zh-v1.5 的 FP32/FP16/INT8 三份 ONNX（约 160MB）
```

模型默认从 `hf-mirror.com` 下载（国内可达），可用 `HF_ENDPOINT=https://huggingface.co` 覆盖。模型只作为静态文件被浏览器下载，不改变推理位置。

### 3. 启动应用

```bash
npm start                     # 默认 http://localhost:8787
# 可用环境变量：SEEKDB_HOST SEEKDB_PORT SEEKDB_PASSWORD SEEKDB_DATABASE PORT（见 .env.example）
```

浏览器打开 <http://localhost:8787>，拖入 `data/demo/` 下的示例文档（或任意 `.txt`/`.md`）即可体验完整流程。

### 嵌入式模式（可选）

Linux/macOS 下可用 `SEEKDB_PATH=/path/to/data npm start` 让 seekdb 以库的形式内嵌在 Node 进程中，无需 Docker。Windows 下嵌入式原生库目前不稳定，建议使用上面的 server 模式。

## 目录结构

```
server/index.mjs        Express 服务：静态资源 + seekdb API（创建集合/写入/refresh/检索）
server/store.mjs        seekdb-js 封装：Schema（HNSW+ngram2）、upsert、refresh_index、hybridSearch
public/app.js           前端：后端探测/降级、向量化、切片、检索、评测、性能基准
public/index.html       单页界面
public/data/eval.json   中文客服评测集（48 篇 / 30 问，含分级相关度）
public/models/          模型文件（fetch-models.mjs 下载，不入库）
data/demo/              演示语料（6 篇 Markdown）
scripts/fetch-models.mjs    模型下载
scripts/quantize_int8.py    INT8 量化复现脚本（onnxruntime 动态量化）
tools/e2e.py                端到端验收（Playwright）
tools/eval_run.py           质量评测采集
tools/bench_run.py          性能基准采集
docker-compose.yml          seekdb server
```

## seekdb 数据层

- 集合 = `kb_<名称>` 表；每条记录包含 512 维向量（HNSW，cosine）、原文（ngram2 全文索引，2-3 字切分）、元数据（source/chunk/chars）
- 写入走 SDK 的 `upsert`（增量导入幂等），写完统一 `refresh_index()`，刷新后新增片段立即可检索（界面有自动校验）
- 混合检索调用 `Collection.hybridSearch()`，由 seekdb 的 `DBMS_HYBRID_SEARCH` 存储过程在数据库内完成 query_string + knn + RRF 融合；客户端只传查询向量与查询原文，**不做任何两路结果的本地拼合**

## 测试与复现

```bash
python tools/e2e.py --headless            # 端到端：导入 → 检索 → 截图
python tools/e2e.py --headless --force-wasm   # 验证 WASM 降级路径
python tools/eval_run.py --headless       # FP32/FP16/INT8 质量对比（见 evidence/eval-result.json）
python tools/bench_run.py --headless      # 批大小/吞吐/延迟基准（见 evidence/bench-result.json）
```

实测数据与结论见 [TECHNICAL.md](./TECHNICAL.md)（一页技术说明）。

## License

MIT（第三方组件与模型来源见 NOTICE）
