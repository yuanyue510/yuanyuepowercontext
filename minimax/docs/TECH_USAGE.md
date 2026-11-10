# 技术使用记录

本文件是三项指定技术的**实际调用留痕**，所有数字都来自 `records/` 下的原始日志，可逐条核对。
记录环境：CentOS 7.9 / Python 3.11.10（Miniconda）/ seekdb 1.4.0 / PowerContext 1.5.1。

---

## 一、MiniMax 使用记录

### 1.1 调用参数

| 项目 | 值 |
| --- | --- |
| 模型 | `MiniMax-M3` |
| 接入方式 | HTTP API，`POST https://api.minimax.chat/v1/text/chatcompletion_v2`（OpenAI 兼容端点作为备用） |
| 消息角色 | `system`：SDD 工程师角色约束；`user`：由上下文模块拼装的开发上下文 |
| temperature | 0.1 |
| 最大尝试 | 3（补丁应用失败或自检失败时，把报错回灌给模型重试） |
| 客户端 | `minimax/agent/minimax_patch.py`，仅用标准库 `urllib`，无第三方 SDK |

### 1.2 本次任务的调用与消耗

`records/minimax_log.jsonl` 记录（本轮第 1 次尝试即成功）：

| 字段 | 值 |
| --- | --- |
| 时间 | 2026-11-10T08:04:07Z |
| 任务 | 为订单查询增加状态过滤与最低金额过滤，并修复金额汇总的浮点误差 |
| 上下文指纹 | `aefd4140dfa8adfa` |
| 提交给模型的规格 | ORDER-REQ-005 / 007 / 008 / 003 / 004 |
| prompt 字符数 | 12214 |
| prompt tokens | 3835 |
| completion tokens | 4880（其中 thinking 4255） |
| 总 tokens | 8715 |
| 耗时 | 35118.1 ms |
| 产出补丁字符数 | 2549 |
| 应用结果 | `python-applier: ordersvc/service.py: 3 个 hunk` |
| 自检结果 | `pytest tests -q` → exit 0 |

对应证据文件：

- `records/minimax_prompt.txt` —— 实际发给模型的完整提示词
- `records/minimax_response.txt` —— 模型原始回复
- `records/patch.diff` —— 从回复中解析出的 unified diff
- `records/minimax_log.jsonl` —— 上述元数据（模型、用量、耗时、应用与自检结果）
- `records/minimax_verify_attempt1.log` —— 应用后自检输出

### 1.3 模型实际改了什么

`records/patch.diff` 共 3 个 hunk，全部落在 `ordersvc/service.py`：

1. `list_orders`：补上 `status` 多值筛选（按逗号切分、去空白、并集、非法值抛 `ValueError`）与
   `min_amount` 闭区间下界筛选；
2. `total_cents`：把 `float` 累加改为 `Decimal` 累加，`int(total * Decimal("100"))` 精确到分；
3. `refund`：补一条未支付/已退款之外的兜底校验（不影响既有行为）。

修改后文件与「基线 + patch.diff」逐字节一致（见 `docs/VERIFICATION.md` 的等价性校验），
说明最终产物完全来自这份补丁，没有人工手改。

### 1.4 使用过程中发现并处理的两个问题

- **模型返回的补丁头偶尔写坏**：一次尝试里 `---`/`+++` 写成了占位符，导致补丁无法应用。
  agent 因此增加了「应用失败 → 回滚 → 带报错重试」，并把手写路径规则写进重试提示。
- **`patch` 命令不可用**：CentOS 7 最小安装没有 `patch`，评审的干净环境也可能没有。
  改为内置纯 Python 应用器 `sdd_context/patchutil.py`，`patch` 仅作兜底。

---

## 二、seekdb 使用记录

### 2.1 库与表

数据库 `sdd_context`，三张表：

| 表 | 作用 | 关键结构 |
| --- | --- | --- |
| `artifact` | 规格 / 代码 / 测试工件 | 主键 `artifact_id`；`FULLTEXT KEY ft_artifact_content(content) WITH PARSER ngram` |
| `embedding` | 工件向量 | `vec VECTOR(1024)`；`VECTOR KEY idx_embedding_vec(vec) WITH (DISTANCE=COSINE, TYPE=HNSW, LIB=VSAG, M=16, EF_CONSTRUCTION=200, EF_SEARCH=64)` |
| `ingest_run` | 每次导入的批次记录 | `run_id` / 起止时间 / 三类工件计数 |

当前存量：**46 个工件**（spec 8 / code 19 / test 19），**46 条向量**。

### 2.2 检索如何被用于构造上下文

一次 `context` 命令实际执行的 SQL 序列（`records/db_query_log.jsonl`，本轮共 202 条）：

1. `search:vector` —— 用任务描述的 hash 向量做 ANN 检索：
   `SELECT ... cosine_distance(vec, %s) AS d FROM embedding ... ORDER BY d LIMIT 20`
2. `search:fulltext` —— 中文 ngram 全文检索：
   `SELECT ... MATCH(content) AGAINST(%s) AS score FROM artifact ... LIMIT 20`
3. 两路结果按 `0.65 * 归一化向量分 + 0.35 * 归一化全文分` 融合排序
4. `get:by_path` —— 按命中规格的 `applies_to` 反查相关代码文件
5. `get:kind:test` —— 取出全部测试工件，按文件定位标注 target / regression

也就是说，交给 MiniMax 的每一条规格、代码、测试都来自库内查询结果，不是硬编码。

### 2.3 规格变更能否被感知

`scripts/spec_update_demo.sh` 把 ORDER-REQ-005 的「大于等于」改成「严格大于」，重新 `ingest` 后：

- 上下文正文随之改变
- 上下文指纹由 `aefd4140dfa8adfa` 变为 `335eb9cd456d8529`
- 对比快照：`records/spec_before.json` / `records/spec_after.json`

---

## 三、PowerContext 使用记录

### 3.1 服务与接入方式

- 版本：`powercontext[cli,server]==1.5.1`，本地服务 `http://127.0.0.1:8000`，SQLite 后端
- 接入方式：HTTP API（`sdd_context/pc_client.py`），不依赖 SDK
- scope：`scp_168rh1aewbhnqzgxfcreb7enzv`

### 3.2 写入内容

一条 Memory（`kind=sdd_task_state`）保存任务进展的紧凑 JSON：

```
[SDD-STATE] {"task_id": "T-ORDER-FILTER", "stage": "verified",
 "completed": ["导入 specs/code/tests 到 seekdb", "构造任务上下文（规格 ORDER-REQ-004/005/007）",
               "MiniMax 生成补丁并应用", "目标测试与回归测试全部通过"],
 "todo": [],
 "verifications": [{"name": "before", "exit_code": 1, "passed": 11, "failed": 8},
                   {"name": "after",  "exit_code": 0, "passed": 19, "failed": 0}],
 "context_fingerprint": "fdaa66886c655cfd",
 "evidence_source_id": "sdd-evidence-T-ORDER-FILTER-after-tests"}
```

测试日志等长文本另存为 Source，Memory 里只留引用，避免单条 Memory 超过 8192 字节上限。

### 3.3 复用验证

两种方式都做了，日志分别是：

- `records/verify_20261110T160330.log` 第 7–8 步：保存状态 → **另起进程** `state-show` 读回 →
  再构造一次上下文，输出里带上「已完成 / 待办 / 验证结果」
- `records/08_state_reuse.log`：从**空状态**开始（`state-show` 返回 1）→ 写入 →
  **重启 PowerContext 服务**（新 pid 与旧 pid 不同）→ 读回成功

---

## 四、复现方式

```bash
cd minimax
cp .env.example .env          # 填 seekdb 连接与 MINIMAX_API_KEY
bash scripts/setup.sh
powercontext server run &     # 另一个终端
bash scripts/verify.sh        # 8 步全流程，日志落在 records/verify_*.log
bash scripts/state_reuse_demo.sh
```

已验证环境：CentOS 7.9、Python 3.11.10、seekdb 1.4.0、PowerContext 1.5.1。
`records/` 里的日志保留的是本机实测路径（如 `/opt/sdd/miniconda3/bin/python`），
在别的机器复现时命令里的解释器路径会不同，其余步骤一致。
