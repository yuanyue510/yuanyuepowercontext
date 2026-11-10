"""回归测试 —— 覆盖 ORDER-REQ-001/002/003/006/008。

修改前后都必须全部通过；任何一条由绿转红即视为破坏既有行为。
"""

from decimal import Decimal

import pytest


def test_list_all_returns_every_order(service):
    """ORDER-REQ-001：无条件查询返回全部订单且保持插入顺序。"""
    orders = service.list_orders()
    assert [order.order_id for order in orders] == [
        "O1001", "O1002", "O1003", "O1004", "O1005", "O1006", "O1007", "O1008",
    ]


def test_filter_by_customer(service):
    """ORDER-REQ-002：按客户过滤。"""
    orders = service.list_orders(customer_id="C002")
    assert {order.order_id for order in orders} == {"O1004", "O1005"}


def test_get_order_returns_exact_order(service):
    """ORDER-REQ-003：单条查询。"""
    order = service.get_order("O1003")
    assert order.customer_id == "C001"
    assert order.amount == Decimal("128.50")


def test_get_order_missing_raises(service):
    """ORDER-REQ-003：不存在的订单抛 KeyError。"""
    with pytest.raises(KeyError):
        service.get_order("O9999")


def test_refund_paid_order_marks_cancelled(service):
    """ORDER-REQ-003：已支付订单可整单退款。"""
    refunded = service.refund("O1001")
    assert refunded.status == "cancelled"
    assert service.get_order("O1001").status == "cancelled"


def test_refund_unpaid_order_rejected(service):
    """ORDER-REQ-003：未支付订单不能退款。"""
    with pytest.raises(ValueError):
        service.refund("O1002")


def test_refund_cancelled_order_rejected(service):
    """ORDER-REQ-003：重复退款被拒绝。"""
    with pytest.raises(ValueError):
        service.refund("O1005")


def test_total_cents_excludes_cancelled(service):
    """ORDER-REQ-008：已取消订单不计入合计。"""
    assert service.total_cents(["O1004", "O1005"]) == 30000


def test_total_cents_empty_orders(service):
    """ORDER-REQ-007 边界：空列表合计为 0。"""
    assert service.total_cents([]) == 0


def test_total_cents_round_amounts_still_exact(service):
    """ORDER-REQ-007 回归：19.99 + 0.01 精确等于 2000 分。"""
    assert service.total_cents(["O1001", "O1002"]) == 2000


def test_total_cents_large_amounts(service):
    """ORDER-REQ-007 回归：128.50 + 300.00 + 1000.00 精确等于 142850 分。"""
    assert service.total_cents(["O1003", "O1004", "O1008"]) == 142850
