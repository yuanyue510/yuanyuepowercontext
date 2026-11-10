"""订单服务：本任务的改造对象。

当前版本（v0.4.1）的已知缺口：
  * list_orders 已经接受 status / min_amount 参数，但尚未真正参与筛选
    （见规格 ORDER-REQ-004、ORDER-REQ-005）。
  * total_cents 用浮点累加后再乘 100 取整，存在分位截断误差
    （见规格 ORDER-REQ-007）。
其余行为见 specs/ 下的规格条目，测试见 tests/。
"""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from typing import Iterable, List, Optional, Sequence

from .models import VALID_STATUSES, Order
from .repository import OrderRepository


class OrderService:
    def __init__(self, repository: OrderRepository) -> None:
        self.repository = repository

    # ------------------------------------------------------------------ 查询
    def list_orders(
        self,
        customer_id: Optional[str] = None,
        status: Optional[str] = None,
        min_amount: Optional[Decimal] = None,
    ) -> List[Order]:
        """按条件列出订单。

        customer_id: 精确匹配客户。
        status:      订单状态筛选，尚未实现（ORDER-REQ-004）。
        min_amount:  金额下限筛选，尚未实现（ORDER-REQ-005）。
        """
        orders: Sequence[Order] = self.repository.all()
        if customer_id is not None:
            orders = [order for order in orders if order.customer_id == customer_id]
        return list(orders)

    def get_order(self, order_id: str) -> Order:
        return self.repository.get(order_id)

    # ------------------------------------------------------------------ 金额
    def total_cents(self, order_ids: Iterable[str]) -> int:
        """汇总给定订单的金额，返回整数分。

        已取消订单不计入（ORDER-REQ-008）。
        """
        total = 0.0
        for order_id in order_ids:
            order = self.repository.get(order_id)
            if order.status == "cancelled":
                continue
            total += float(order.amount)
        return int(total * 100)

    # ------------------------------------------------------------------ 退款
    def refund(self, order_id: str) -> Order:
        """整单退款。仅 paid / shipped 可退，退款后置为 cancelled。"""
        order = self.repository.get(order_id)
        if order.status == "cancelled":
            raise ValueError(f"order already cancelled: {order_id}")
        if order.status == "created":
            raise ValueError(f"unpaid order cannot be refunded: {order_id}")
        refunded = replace(order, status="cancelled")
        self.repository.save(refunded)
        return refunded
