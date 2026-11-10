# 规有所依 —— 面向软件持续演进的 SDD 上下文管理系统

> MiniMax × OceanBase 2026 生态竞赛参赛作品（`minimax/` 目录）
> 基分支：`2026-competition-ecosystem`（`d647275c308e09b7b623f322a26f5c4e85734fb0`）

AI 开发助手改代码时必须同时回答三个问题：**该守哪些规格、该动哪些代码、该跑哪些测试**。
本项目实现一个可被 Agent 调用的工程上下文模块，把这三件事从"翻文档 / 猜"变成"查一次库"，
并用一次真实的代码修改证明它有效。

## 一句话流程

```
开发任务 ──▶ seekdb（规格/代码/测试工件 + 向量索引 + 全文索引）
                │  混合检索 + 关系扩展
                ▼
         context.json（规格 + 代码 + 测试，逐条带文件行号）
                │
                ├──▶ MiniMax：生成补丁 ──▶ 应用 ──▶ pytest 由红转绿
                └──▶ PowerContext：保存任务进展 ──▶ 重启后读回
```

## 三项指定技术各自承担什么

| 技术 | 在流程中的实际作用 | 证据 |
| --- | --- | --- |
| **MiniMax** | 读取上下文模块产出的规格/代码/测试，生成 unified diff，由内置应用器落盘改掉 `ordersvc/service.py` | `records/minimax_log.jsonl`、`records/patch.diff`、`records/minimax_response.txt` |
| **seekdb** | 存放 46 个工程工件（8 规格 / 19 代码符号 / 19 测试），建 `VECTOR(1024)` HNSW 索引与中文 ngram 全文索引；任务上下文的每条内容都来自库内查询 | `records/db_query_log.jsonl`、`sdd_context/db.py` |
| **PowerContext** | 以 Memory 保存任务进展（阶段/已完成/待办/两次测试结果），以 Source 保存测试日志；模块重启后按任务号检索读回 | `records/powercontext_log.jsonl`、`python -m sdd_context state-show` |

## 目录

```
minimax/
├── sdd_context/           # 上下文模块（本题主体）
│   ├── cli.py             #   调用入口：init-db / ingest / context / state-*
│   ├── db.py              #   seekdb 访问层（建表、向量检索、全文检索）
│   ├── ingest.py          #   规格(Markdown) / 代码(AST) / 测试(AST) 解析入库
│   ├── retrieve.py        #   混合召回 + 关系扩展，产出 context
│   ├── patchutil.py       #   纯 Python unified diff 应用器（不依赖 patch 命令）
│   ├── state.py           #   任务状态模型（PowerContext Memory / Source）
│   ├── embed.py           #   向量化后端（hash 默认 / MiniMax embo-01）
│   └── pc_client.py       #   PowerContext HTTP 客户端
├── agent/minimax_patch.py # 用 MiniMax 依据上下文改代码（自带失败重试）
├── sample_project/        # 业务工程：订单服务 + 规格 + 测试（改造对象）
├── scripts/               # setup / verify / reset / 规格变更演示 / 状态复用 / MiniMax 自检
├── docs/                  # DESIGN（一页技术说明）/ RUNBOOK / VERIFICATION
└── records/               # 运行记录：MiniMax、SQL、PowerContext、测试日志
```

## 快速开始

```bash
cd minimax
cp .env.example .env                  # 填 seekdb 连接、MINIMAX_API_KEY
bash scripts/setup.sh                 # 装 pymysql + pytest
bash scripts/check_minimax.sh         # 可选：先确认 Key / 模型 / 额度
# 另一个终端：启动任务状态服务（无需模型 API）
pip install "powercontext[cli,server]==1.5.1" && powercontext server run
bash scripts/verify.sh                # 一键跑完 8 个步骤
bash scripts/state_reuse_demo.sh      # 单独演示：状态写入 → 服务重启 → 读回
bash scripts/replay_recorded_patch.sh # 没有 MiniMax Key 时：重放记录中的补丁，复现「8 红 → 19 绿」
```

完整依赖、配置项与已知限制见 [docs/RUNBOOK.md](docs/RUNBOOK.md)；
模块结构、选择算法与技术分工见 [docs/DESIGN.md](docs/DESIGN.md)；
验证样例（任务、必含来源、预期结果、重置方法）见 [docs/VERIFICATION.md](docs/VERIFICATION.md)；
MiniMax / seekdb / PowerContext 的实测调用留痕见 [docs/TECH_USAGE.md](docs/TECH_USAGE.md)。

## 验收对照

| 必做项 | 本作品如何满足 |
| --- | --- |
| 能够运行 | `scripts/setup.sh` → `scripts/verify.sh` 全自动；seekdb 可用同机或远端，无隐式本地状态 |
| MiniMax 实际参与 | `agent/minimax_patch.py` 真实调用，日志含模型、prompt、usage、补丁与落盘结果，与 `records/patch.diff` 一一对应 |
| 上下文正确 | `context.json` 列出规格 ID / 代码符号 / 测试 node id 与 `文件:行号`；规格改动后重新 `ingest`，上下文正文与指纹随之变化 |
| 数据库实际参与 | 上下文由 `vector_search` + 全文检索的结果拼装；`db_query_log.jsonl` 记录每条 SQL、参数与耗时 |
| 状态能够复用 | `state-*` 子命令走 PowerContext；`state-show` 在独立进程中读回同一份状态 |
| 代码修改有效 | 修改前 8 个目标用例失败（功能缺失），修改后 19 个用例全绿，且测试文件零改动 |
