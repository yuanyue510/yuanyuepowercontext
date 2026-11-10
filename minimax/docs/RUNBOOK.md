# 运行说明

## 1. 依赖与版本

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Python | 3.11+（实测 3.11.10） | 上下文模块与样例工程 |
| pymysql | ≥ 1.1.0 | 访问 seekdb / OceanBase 的 MySQL 协议 |
| pytest | ≥ 8.0 | 样例工程的测试运行器 |
| PowerContext | 1.5.1（`powercontext[cli,server]`） | 任务状态服务，SQLite 后端即可 |
| seekdb | 1.4.0（或任意 OceanBase ≥ 4.3.5） | 工程资料库；需支持 `VECTOR` 类型与 HNSW 索引 |
| MiniMax | 对话模型（默认 `MiniMax-M2`，可配） | 生成补丁 |

`seekdb` 的安装方式见 OceanBase 官方文档（RPM / Docker 均可）。本作品实测环境：
CentOS 7.9 单机，seekdb 1.4.0 以 RPM 安装并 `systemctl start seekdb`，监听 `2881`。

## 2. 配置

```bash
cd minimax
cp .env.example .env
```

`.env` 关键项：

| 变量 | 用途 | 示例 |
| --- | --- | --- |
| `SDD_DB_HOST` / `SDD_DB_PORT` / `SDD_DB_USER` / `SDD_DB_PASSWORD` | seekdb 连接 | `127.0.0.1` / `2881` / `root` / 空 |
| `SDD_DB_NAME` | 上下文库名（自动创建） | `sdd_context` |
| `SDD_EMBED_PROVIDER` | `hash`（默认，零依赖）或 `minimax` | `hash` |
| `SDD_EMBED_DIM` | 向量维度，需与 `embedding.vec` 列一致 | `1024` |
| `MINIMAX_API_KEY` | MiniMax 凭据（代码修改必需） | `sk-****` |
| `MINIMAX_BASE_URL` / `MINIMAX_MODEL` | 接口与模型 | `https://api.minimax.chat` / `MiniMax-M2` |
| `MINIMAX_API_STYLE` | `auto` / `chatcompletion_v2` / `openai` | `auto` |
| `POWERCONTEXT_URL` | 任务状态服务地址 | `http://127.0.0.1:8000` |

`.env` 含凭据，已在 `.gitignore` 中排除；仓库里只保留占位值。

## 3. 数据初始化

```bash
# 1) 建库建表（含 HNSW 向量索引、中文 ngram 全文索引）
python -m sdd_context init-db

# 2) 导入规格 / 代码 / 测试
python -m sdd_context ingest --root sample_project
#    -> 46 个工件：8 规格 / 19 代码符号 / 19 测试

# 3) 查看库内状态
python -m sdd_context stats
```

`ingest` 是"全量对齐"：同名工件按内容哈希覆盖，本次扫描不到的工件会被删除。
因此修改 `specs/*.md` 后重新执行 `ingest`，上下文立即反映新内容。

## 4. 调用入口

### 4.1 上下模块（本题主体）

```bash
python -m sdd_context context --task "<任务描述>" --out records/context.json
python -m sdd_context context --task "<任务描述>" --render   # 打印给模型看的 Markdown
```

输出 JSON 结构：

```json
{
  "task": "…",
  "specs":   [{"id": "ORDER-REQ-004", "title": "...", "path": "specs/order-query.md",
               "line": 34, "body": "...", "score": 0.24, "matched_by": ["vector","lexical"],
               "revision": "9f2c…"}],
  "code":    [{"path": "ordersvc/service.py", "symbol": "OrderService.list_orders",
               "start_line": 26, "end_line": 41, "source": "...", "reason": "…"}],
  "tests":   [{"node_id": "tests/test_query_target.py::test_filter_by_status_single",
               "role": "target", "covered_specs": ["ORDER-REQ-004"], "line": 20}],
  "db_evidence": {"db": "127.0.0.1:2881/sdd_context", "vector_hits": 20, "lexical_hits": 20},
  "context_fingerprint": "738d1632624973fa"
}
```

也可以直接当库用：

```python
from sdd_context import Config, build_context
from sdd_context.db import SeekDB

cfg = Config.from_env()
ctx = build_context("为订单查询增加状态过滤", cfg, SeekDB(cfg))
print([s["id"] for s in ctx.specs], [c["symbol"] for c in ctx.code])
```

### 4.2 任务状态

```bash
python -m sdd_context state-save --task-id T-ORDER-FILTER --stage verified \
    --completed "导入资料" --todo "无" --fingerprint 738d1632624973fa
python -m sdd_context state-show --task-id T-ORDER-FILTER
```

`state-show` 每次都运行在**新进程**中，状态来自 PowerContext 的 Memory，因此可用于
验证"重启后读回"。完整写法见 `scripts/verify.sh` 第 7、8 步。

### 4.3 MiniMax 改代码

```bash
python agent/minimax_patch.py --context records/context.json --apply
```

行为：拼提示词 → 调 MiniMax → 抽 unified diff → 写 `records/patch.diff` → `patch -p1` 应用。
日志追加到 `records/minimax_log.jsonl`（模型、prompt 字数、usage、补丁字数、是否应用成功）。

## 5. 测试命令

```bash
cd sample_project
python -m pytest tests -q                     # 全部
python -m pytest tests/test_query_target.py -q  # 只跑目标用例
```

## 6. 已知限制

1. **向量后端默认是确定性哈希**（`hash-1024`），不是语义向量；召回质量依赖关键词重叠。
   切到 MiniMax `embo-01` 需 API Key，且切换后必须重新 `ingest`（向量维度/空间变了）。
2. **规格解析是约定式的**：`### <ID> <标题>` + `- applies_to:` / `- verifies:`。
   不符合该格式的 Markdown 不会被切分成规格工件。
3. **代码解析只支持 Python**（AST）。其它语言需换解析器，接口保持不变。
4. **PowerContext 用 SQLite 后端**（其默认）。也可以指向 OceanBase，但需要按其数据库迁移
   流程单独建表；为降低评审环境依赖，本作品未启用。
5. **`patch` 应用是"尽力而为"**：模型若给出与当前文件不匹配的 hunk，`patch` 会失败并返回
   非零退出码，此时 `records/minimax_response.txt` 保留原文供人工处理。
6. 样例工程刻意做小（8 张订单、19 个用例），用于快速演示"红 → 绿"，不代表生产规模。
