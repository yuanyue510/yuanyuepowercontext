"""内存订单仓库。评审可用 reset() 回到初始数据。"""

from __future__ import annotations

from decimal import Decimal
from typing import Dict, Iterable, List

from .models import Order

_SEED = [
    # order_id, customer_id, status, amount, created_at
    ("O1001", "C001", "paid", "19.99", "2026-03-01T10:00:00Z"),
    ("O1002", "C001", "created", "0.01", "2026-03-01T11:30:00Z"),
    ("O1003", "C001", "shipped", "128.50", "2026-03-02T09:15:00Z"),
    ("O1004", "C002", "paid", "300.00", "2026-03-02T14:45:00Z"),
    ("O1005", "C002", "cancelled", "75.20", "2026-03-03T08:05:00Z"),
    ("O1006", "C003", "created", "2.00", "2026-03-03T16:20:00Z"),
    ("O1007", "C003", "paid", "1.13", "2026-03-04T10:10:00Z"),
    ("O1008", "C001", "paid", "1000.00", "2026-03-04T18:00:00Z"),
]


class OrderRepository:
    """内存实现，接口形状与生产环境的 DB 仓储保持一致。"""

    def __init__(self) -> None:
        self._orders: Dict[str, Order] = {}
        self.reset()

    def reset(self) -> None:
        self._orders = {
            oid: Order(
                order_id=oid,
                customer_id=cid,
                status=status,
                amount=Decimal(amount),
                created_at=created_at,
            )
            for oid, cid, status, amount, created_at in _SEED
        }

    def all(self) -> List[Order]:
        # 保持插入顺序，列表接口的行为依赖这一点
        return list(self._orders.values())

    def get(self, order_id: str) -> Order:
        try:
            return self._orders[order_id]
        except KeyError as exc:
            raise KeyError(f"order not found: {order_id}") from exc

    def save(self, order: Order) -> None:
        self._orders[order.order_id] = order

    def extend(self, orders: Iterable[Order]) -> None:
        for order in orders:
            self.save(order)
