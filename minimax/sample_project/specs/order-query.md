# 订单查询规格

本文件是订单查询能力的唯一规格来源（single source of truth）。
每条规格以 `### <ID> <标题>` 开头，元数据用 `- key: value` 列表声明。

### ORDER-REQ-001 全量查询

- applies_to: ordersvc/service.py
- verifies: tests/test_regression.py
- tags: query, listing

`list_orders()` 在不传任何筛选参数时必须返回全部订单，并保持仓库的插入顺序。
该行为是列表页的默认视图，不得因为新增筛选能力而改变。

### ORDER-REQ-002 按客户过滤

- applies_to: ordersvc/service.py
- verifies: tests/test_regression.py
- tags: query, filter, customer

`customer_id` 参数用于精确匹配客户，过滤后仍需保持插入顺序。
`customer_id=None` 表示不限制客户。

### ORDER-REQ-003 单条查询与退款

- applies_to: ordersvc/service.py, ordersvc/repository.py
- verifies: tests/test_regression.py
- tags: query, refund

`get_order(order_id)` 返回对应订单，订单不存在时抛 `KeyError`。
`refund(order_id)` 仅允许 `paid` / `shipped` 状态整单退款，退款后状态置为 `cancelled`；
对 `created`（未支付）或 `cancelled`（已退款）状态调用必须抛 `ValueError`。

### ORDER-REQ-004 订单状态过滤

- applies_to: ordersvc/service.py
- verifies: tests/test_query_target.py
- tags: query, filter, status

`list_orders(status=...)` 必须按订单状态筛选：

1. `status` 支持单值，如 `status="paid"`；
2. `status` 支持逗号分隔的多值，如 `status="created,cancelled"`，多值之间取并集；
3. 多值两侧的空白需要忽略，如 `status="paid, shipped"`；
4. 出现任何不在 `created` / `paid` / `shipped` / `cancelled` 中的取值时，必须抛出
   `ValueError`，不得静默忽略；
5. `status=None` 表示不按状态限制。

### ORDER-REQ-005 按最低金额过滤

- applies_to: ordersvc/service.py
- verifies: tests/test_query_target.py
- tags: query, filter, money

`list_orders(min_amount=...)` 必须筛出金额 **大于等于** `min_amount` 的订单（闭区间下界）。
比较必须使用 `Decimal`，不得先转成 `float` 再比较。
`min_amount=None` 表示不限制金额；与 `customer_id`、`status` 同时出现时取交集。

### ORDER-REQ-006 结果顺序

- applies_to: ordersvc/service.py
- verifies: tests/test_query_target.py, tests/test_regression.py
- tags: query, ordering

任何筛选组合下，返回结果都必须保持仓库的插入顺序，不得因过滤实现使用集合、
字典键序或排序而改变顺序。
