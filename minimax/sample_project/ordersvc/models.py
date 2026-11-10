"""订单领域模型。"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

VALID_STATUSES = ("created", "paid", "shipped", "cancelled")


@dataclass(frozen=True)
class Order:
    """一张订单。amount 使用 Decimal，避免金额在模型层就被浮点污染。"""

    order_id: str
    customer_id: str
    status: str
    amount: Decimal
    created_at: str

    def __post_init__(self) -> None:
        if self.status not in VALID_STATUSES:
            raise ValueError(f"unknown status: {self.status}")
        if not isinstance(self.amount, Decimal):
            raise TypeError("amount must be Decimal")
