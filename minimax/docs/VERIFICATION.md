# 验证样例

## 1. 任务描述

> 为订单查询增加状态过滤与最低金额过滤，并修复金额汇总的浮点误差。

改造对象是 `sample_project/`（一个可运行、带测试的小型订单服务）：

- `list_orders()` 已经接受 `status` / `min_amount` 参数，但参数没有参与筛选；
- `total_cents()` 用 `float` 累加后乘 100 取整，会出现分位截断（0.01 + 2.00 得 200 分而不是 201 分）。

改动范围限定为 `ordersvc/service.py`，**测试文件为验收标准，不得修改**。

## 2. 有效规格（上下文必须包含）

| 规格 ID | 文件:行 | 关键约束 |
| --- | --- | --- |
| `ORDER-REQ-004` | `specs/order-query.md:34` | status 支持单值/逗号多值/忽略空白；非法状态抛 `ValueError`；`None` 不过滤 |
| `ORDER-REQ-005` | `specs/order-query.md:49` | `min_amount` 为闭区间下界；必须用 `Decimal` 比较；与其它条件取交集 |
| `ORDER-REQ-007` | `specs/money.md:3` | `total_cents` 必须用 `Decimal` 累加，返回整数分；空列表返回 0 |
| `ORDER-REQ-006` | `specs/order-query.md:59` | 任何筛选组合下保持插入顺序 |
| `ORDER-REQ-003` | `specs/order-query.md:24` | 退款规则（不得因改造被破坏） |
| `ORDER-REQ-008` | `specs/money.md:16` | 已取消订单不计入合计（不得因改造被破坏） |

前三条是**本次任务的功能来源**，后三条是**兼容性约束**。检索会给出一组按相关度排序的规格，
实际运行时为：`ORDER-REQ-005`(0.54) → `007`(0.47) → `008`(0.34) → `003`(0.24) → `004`(0.24)。

## 3. 上下文必须包含的代码与测试来源

**代码**（`code` 字段，带文件与行号）：

| 符号 | 位置 | 说明 |
| --- | --- | --- |
| `OrderService.list_orders` | `ordersvc/service.py:26-41` | 参数未参与筛选，改造点之一 |
| `OrderService.total_cents` | `ordersvc/service.py:47-58` | 浮点累加，改造点之二 |
| `OrderService.refund` / `get_order` / `OrderService` | `ordersvc/service.py:43-70` | 同文件上下文，保证不破坏既有行为 |

**测试**（`tests` 字段，带 node id 与角色）：

| 角色 | node id | 期望 |
| --- | --- | --- |
| target | `tests/test_query_target.py::test_filter_by_status_single` | 修改前失败 |
| target | `tests/test_query_target.py::test_filter_by_status_multi` | 修改前失败 |
| target | `tests/test_query_target.py::test_filter_by_status_unknown_raises` | 修改前失败 |
| target | `tests/test_query_target.py::test_filter_by_min_amount_inclusive` | 修改前失败 |
| target | `tests/test_query_target.py::test_filter_combines_customer_and_status` | 修改前失败 |
| target | `tests/test_query_target.py::test_filter_preserves_insert_order` | 修改前失败 |
| target | `tests/test_money_target.py::test_total_cents_no_truncation_small_amounts` | 修改前失败 |
| target | `tests/test_money_target.py::test_total_cents_no_truncation_odd_cents` | 修改前失败 |
| regression | `tests/test_regression.py::*`（11 条） | 修改前后都必须通过 |

## 4. 初始数据

`ordersvc/repository.py` 内置 8 张订单，`reset()` 可复原：

| 订单 | 客户 | 状态 | 金额 |
| --- | --- | --- | --- |
| O1001 | C001 | paid | 19.99 |
| O1002 | C001 | created | 0.01 |
| O1003 | C001 | shipped | 128.50 |
| O1004 | C002 | paid | 300.00 |
| O1005 | C002 | cancelled | 75.20 |
| O1006 | C003 | created | 2.00 |
| O1007 | C003 | paid | 1.13 |
| O1008 | C001 | paid | 1000.00 |

金额组合是刻意挑的：`0.01 + 2.00` 与 `0.01 + 1.13` 在浮点截断下分别得 200 / 113 分（应为 201 / 114）。

## 5. 操作步骤

```bash
cd minimax
cp .env.example .env                       # 填 seekdb 连接与 MINIMAX_API_KEY
bash scripts/setup.sh                      # 安装 pymysql / pytest

# 另开终端启动任务状态服务（SQLite 后端，不需要模型 API）
pip install "powercontext[cli,server]==1.5.1"
powercontext server run

bash scripts/verify.sh                     # 8 步全流程
```

分步执行（便于逐项核对）：

```bash
python -m sdd_context init-db
python -m sdd_context ingest --root sample_project
python -m sdd_context context --task "为订单查询增加状态过滤与最低金额过滤，并修复金额汇总的浮点误差" \
       --out records/context.json --task-id T-ORDER-FILTER   # 带上任务号 → 输出并入已保存进展
(cd sample_project && python -m pytest tests -q)          # 预期 8 failed / 11 passed
python agent/minimax_patch.py --context records/context.json --apply \
       --verify-cmd "python -m pytest tests -q"           # 应用失败或自检失败会自动重试
(cd sample_project && python -m pytest tests -q)          # 预期 19 passed
python -m sdd_context state-show --task-id T-ORDER-FILTER # 新进程读回状态
```

## 6. 预期结果

| 步骤 | 预期 |
| --- | --- |
| `init-db` | `capabilities={"vector_index": true, "fulltext": "ngram"}` |
| `ingest` | 46 个工件（8 规格 / 19 代码 / 19 测试） |
| `context` | 5 条规格、13 个代码符号、19 条测试；含 `context_fingerprint`（本机为 `aefd4140dfa8adfa`，同输入可复现） |
| 修改前 `pytest` | `8 failed, 11 passed`，失败全部落在 `test_query_target.py` / `test_money_target.py` |
| MiniMax 补丁 | 只改 `ordersvc/service.py`；测试文件哈希前后一致 |
| 修改后 `pytest` | `19 passed` |
| `state-show` | 打印阶段 `verified`、已完成 4 项、两次验证结果（before: rc≠0、after: rc=0） |

## 6.1 实际运行结果（本机实测）

`records/verify_20261110T160702.log`（退出码 0）：

| 验收关注点 | 实测 | 证据 |
| --- | --- | --- |
| 能够运行 | `init-db` / `ingest` / `context` / 测试 / MiniMax / 状态全部通过，无手工干预 | `records/verify_*.log` |
| MiniMax 实际参与 | MiniMax-M3，prompt 3835 tokens，completion 4880 tokens，产出 3 个 hunk | `records/minimax_log.jsonl`、`records/minimax_response.txt` |
| 上下文正确 | 5 条规格 + 13 个代码符号 + 19 条测试，均带 `文件:行号` | `records/context.json` |
| 数据库实际参与 | 一次 context 触发 202 条 SQL（向量检索 + ngram 全文检索 + 关系扩展） | `records/db_query_log.jsonl` |
| 状态能够复用 | 保存后新进程读回；再构造上下文时并入「阶段/已完成/验证结果」；另有服务重启版演示 | `records/09_context_with_state.log`、`records/08_state_reuse.log` |
| 代码修改有效 | 修改前 `8 failed, 11 passed` → 修改后 `19 passed`，测试文件哈希未变 | `records/01_before_tests.log`、`records/03_after_tests.log`、`records/00_tests_hash_*.txt` |

**产物等价性校验**：把 `records/patch.diff` 应用到 `baseline/service.py` 的副本，结果与
`records/snapshot_after_service.py` 逐字节一致——最终代码完全来自 MiniMax 的补丁，没有任何手改。

## 6.2 没有 MiniMax Key 时如何核对「代码修改有效」

评审环境通常不会带参赛者的模型 Key，因此提供一条不依赖模型的复现路径：

```bash
bash scripts/replay_recorded_patch.sh
```

该脚本做的事：

1. 把 `sample_project/ordersvc/service.py` 复位到 `baseline/service.py`（修改前快照）；
2. 跑测试 → 期望 `8 failed, 11 passed`，退出码非 0；
3. 把 `records/patch.diff`（MiniMax 当时真实产出的补丁）用内置应用器重放到代码上；
4. 再跑测试 → 期望 `19 passed`，退出码 0；
5. 与 `records/snapshot_after_service.py` 比对，确认与记录中的修改后快照一致；
6. 还原到基线，工作区保持「修改前」状态。

实测输出见 `records/10_replay_patch.log`。这条路径只重放已验证的补丁，
不重新调用模型——符合题面「MiniMax 的使用通过开发记录核对，不要求模型重新生成完全相同的补丁」。

## 7. 规格变更演示（证明不是固定答案）

```bash
bash scripts/spec_update_demo.sh
```

脚本会把 `ORDER-REQ-005` 的下界语义从"大于等于"改成"严格大于"，重新 `ingest` 后再次
`context`，打印：

- 上下文正文中该条规格的新文字；
- `context_fingerprint` 由旧值变为新值；
- `records/06_spec_update.log` 中保存前后对比。

脚本结束会自动还原规格文件。

## 8. 重置方法

```bash
bash scripts/reset.sh           # 还原 sample_project 到修改前，清理 records 中的中间产物
python -m sdd_context ingest --root sample_project   # 如需清空并重建库内工件
```

`reset.sh` 优先用 `git checkout -- minimax/sample_project` 还原；**环境里没有 git 时**
（例如直接把目录拷到服务器）自动退回 `baseline/service.py` 快照还原，不依赖 VCS。
库内工件与 PowerContext 状态保留，重新 `ingest` / `state-save` 会覆盖。

`scripts/verify.sh` 自身也会在开头做一次基线复位，因此可以反复执行，每次都是
「修改前失败 → 修改后通过」的完整对比。
