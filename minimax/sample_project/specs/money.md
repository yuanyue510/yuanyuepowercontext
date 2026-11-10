# 金额计算规格

### ORDER-REQ-007 金额汇总精度

- applies_to: ordersvc/service.py
- verifies: tests/test_money_target.py, tests/test_regression.py
- tags: money, decimal, precision

`total_cents(order_ids)` 汇总给定订单金额并返回**整数分**。

1. 累加过程必须使用 `Decimal`，禁止用 `float` 累加后再乘 100 取整；
2. 结果必须是精确到分的整数，例如 19.99 + 0.01 必须得到 2000 分，而不是 1999 分；
3. 空列表返回 0；
4. 该函数只做汇总，不修改任何订单状态。

### ORDER-REQ-008 已取消订单不计入合计

- applies_to: ordersvc/service.py
- verifies: tests/test_regression.py
- tags: money, status

`total_cents` 必须跳过状态为 `cancelled` 的订单。
该规则对退款后的订单同样生效：订单退款后再次汇总时不得计入其金额。
