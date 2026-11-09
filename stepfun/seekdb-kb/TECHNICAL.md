# 一页技术说明 · 端侧书房（浏览器本地向量化 + seekdb 混合检索）

## 1. 模型与量化

| 项目 | 内容 |
| --- | --- |
| 模型 | **bge-small-zh-v1.5**（BAAI，MIT License），BERT 4 层 / hidden 512 / 24M 参数，输出 512 维 |
| 来源与版本 | 浏览器端权重取自 Transformers.js 官方转换版 `Xenova/bge-small-zh-v1.5`（FP32/FP16/INT8 三份 ONNX）；查询侧使用官方检索指令前缀 |
| 量化方式 | **INT8 动态量化**：per-channel、reduce_range、权重 QInt8（optimum/ONNX Runtime，与仓库内 `quantize_config.json` 一致）；复现脚本 `scripts/quantize_int8.py` |
| FP16 | 直接转换的半精度权重，仅在 WebGPU 后端使用（WASM 不支持 fp16 计算图） |
| 体积与压缩比 | FP32 **90.5 MB** → FP16 **45.3 MB**（2.00×）→ INT8 **22.9 MB**（**3.95×**），按浏览器实际下载字节数统计 |
| 检索质量变化 | 见 §4.1：三种精度的 Recall@5 / nDCG@10 / MRR **完全一致**（0.933 / 0.936 / 0.927），INT8 量化在本评测集上未造成可观测的质量损失 |

## 2. 端侧运行

- **运行时**：Transformers.js 3.7（ONNX Runtime Web），模型经 `/vendor` 与 `/models` 静态路由从本地服务下发，`env.allowRemoteModels=false` 保证不访问任何云端推理端点
- **WebGPU 选择**：启动时 `navigator.gpu.requestAdapter()` 探测；适配器存在且支持 `shader-f16` 时加载 FP16 权重（`device:'webgpu', dtype:'fp16'`），无 f16 时降为 FP32
- **WASM 自动降级**：无 `navigator.gpu`、适配器为 null 或 WebGPU pipeline 初始化抛错时，自动改用 `device:'wasm', dtype:'q8'`（INT8），顶栏徽章与悬浮提示明确显示当前后端与降级原因，核心流程不变
- **降级验证**：`?forceWasm=1` 强制走 WASM 路径（用于验收），`tools/e2e.py --force-wasm` 在无 GPU 条件下完成导入 + 检索全流程；WASM 后端开启 4 线程（页面带 COOP/COEP 头启用 SharedArrayBuffer）
- **纯本地推理**：文档与查询向量全部在浏览器内计算；服务端只做静态资源分发与 seekdb 代理，代码中无任何云端推理调用

## 3. seekdb 使用

- **部署**：官方镜像 `oceanbase/seekdb`（docker-compose.yml，端口 2881/2886）；也支持 `SEEKDB_PATH` 嵌入式模式（Linux/macOS）
- **集合/表结构**：每个知识库一张表 `kb_<名称>`：512 维向量列（HNSW，cosine，M=16/efC=200/efS=128）、原文列（**ngram2 全文索引**，2~3 字切分，适配中文）、metadata JSON（source/chunk/chars）
- **混合检索**：SDK `Collection.hybridSearch()` → seekdb `DBMS_HYBRID_SEARCH` 存储过程，`query_string`（全文）+ `knn`（HNSW）双路召回，**RRF（rank_constant=60, rank_window_size=40）在数据库内融合排序**；客户端只提交查询原文与查询向量，不存在本地拼合
- **增量写入与刷新**：分批 `upsert`（64 条/批，重复导入幂等）→ 全部写完后调用 `refresh_index()` → 自动用新增片段做一次向量检索校验，命中即提示「刷新后新增内容可检索」
- **状态管理**：多集合创建/切换/删除；当前集合与会话状态持久化于 localStorage，切换后检索结果严格对应当前集合（服务端按集合名路由）

## 4. 实测结果

**测试条件**：Windows 11（i7-12700H，Intel Iris Xe GPU）/ Chrome 156.0.8078.48（无头模式下 WebGPU 可用）/ seekdb 1.4.0（虚拟机 server 模式）/ 评测集 48 篇 / 30 问（`public/data/eval.json`）/ TopK=10 / RRF constant=60。

### 4.1 检索质量（SeekDB 混合检索，同一评测集）

| 配置 | 模型体积 | Recall@5 | nDCG@10 | MRR |
| --- | --- | --- | --- | --- |
| FP32 + WASM（基线） | 90.5 MB | 0.9333 | 0.9360 | 0.9267 |
| INT8 + WASM | 22.9 MB | 0.9333（±0） | 0.9360（±0） | 0.9267（±0） |
| FP16 + WebGPU | 45.3 MB | 0.9333（±0） | 0.9360（±0） | 0.9267（±0） |

量化后质量**零损失**：三条配置的排序结果在全部 30 条查询上指标一致。评测方法：48 篇语料 / 30 条中文查询，人工标注分级相关度（qrel），检索统一走 seekdb `DBMS_HYBRID_SEARCH`（RRF），TopK=10。

### 4.2 性能（64 段文档向量化取 3 轮中位数；查询延迟 p50/p95，30 次）

| 配置 | 文档向量化吞吐（batch=16） | 查询向量化 p50 | seekdb 混合检索 p50 | 端到端查询 |
| --- | --- | --- | --- | --- |
| FP16 + WebGPU | 133.8 段/s（478 ms/64 段） | 75.1 ms | 58.6 ms | ≈134 ms |
| INT8 + WASM | 5.8 段/s（11034 ms/64 段）* | 21.1 ms | 32.2 ms | ≈53 ms |

\* WASM 数值波动大（同轮 bs=32 实测 1119 ms/64 段 = 57.2 段/s，bs=1 为 4883 ms），受浏览器并发调度影响明显，取值仅为中位数快照；WebGPU 在 batch=8/16/32 下稳定在 119~187 段/s。整库导入实测（6 篇 / 22 段）：WebGPU 740 ms，WASM 31.4 s。

模型加载：冷启动（含首次权重传输 + 初始化 + 预热）2070 ms，二次冷启动 1691 ms，页面热重载（浏览器缓存命中）1265 ms（WebGPU·FP16，模型由本地服务静态下发）。

### 4.3 优化点

1. **批处理**：向量化按批提交（默认 16，可调 4/16/32/64），比逐条显著提升吞吐（见 bench 数据）
2. **模型加载**：加载后立即预热一轮推理，把首次 kernel 编译/内存分配从用户检索路径剔除；权重按需选择（WASM 只下载 22.9MB 的 INT8，WebGPU 只下载 45.3MB 的 FP16）
3. **写入与索引**：批量 upsert + 一次 `refresh_index`（而非每批刷新），减少索引重建次数
4. **检索**：RRF 融合完全在 seekdb 内执行，避免两路结果跨进程传输与客户端合并

原始数据：`evidence/eval-result.json`、`evidence/bench-result.json`、`evidence/boot-time.json`；复现命令见 README「测试与复现」。
