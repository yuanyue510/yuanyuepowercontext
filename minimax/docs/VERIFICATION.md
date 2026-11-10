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
       --out records/context.json
(cd sample_project && python -m pytest tests -q)          # 预期 8 failed / 11 passed
python agent/minimax_patch.py --context records/context.json --apply
(cd sample_project && python -m pytest tests -q)          # 预期 19 passed
python -m sdd_context state-show --task-id T-ORDER-FILTER # 新进程读回状态
```

## 6. 预期结果

| 步骤 | 预期 |
| --- | --- |
| `init-db` | `capabilities={"vector_index": true, "fulltext": "ngram"}` |
| `ingest` | 46 个工件（8 规格 / 19 代码 / 19 测试） |
| `context` | 5 条规格、13 个代码符号、19 条测试；含 `context_fingerprint` |
| 修改前 `pytest` | `8 failed, 11 passed`，失败全部落在 `test_query_target.py` / `test_money_target.py` |
| MiniMax 补丁 | 只改 `ordersvc/service.py`；`git diff --name-only` 不含 `tests/` |
| 修改后 `pytest` | `19 passed` |
| `state-show` | 打印阶段 `verified`、已完成 4 项、两次验证结果（before: rc≠0、after: rc=0） |

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

`reset.sh` 通过 `git checkout -- minimax/sample_project` 还原代码；库内工件与 PowerContext
状态保留，重新 `ingest` / `state-save` 会覆盖。
