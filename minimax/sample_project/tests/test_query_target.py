"""目标功能测试（查询侧）—— 覆盖 ORDER-REQ-004 / ORDER-REQ-005。

修改前：这些用例应因"参数未参与筛选"而失败。
修改后：必须全部通过，且不得改动本文件。
"""

from decimal import Decimal


def _ids(orders):
    return {order.order_id for order in orders}


def test_filter_by_status_single(service):
    """ORDER-REQ-004：status 单值过滤，只返回该状态的订单。"""
    orders = service.list_orders(status="paid")
    assert _ids(orders) == {"O1001", "O1004", "O1007", "O1008"}
    assert all(order.status == "paid" for order in orders)


def test_filter_by_status_multi(service):
    """ORDER-REQ-004：status 支持逗号分隔多值。"""
    orders = service.list_orders(status="created,cancelled")
    assert _ids(orders) == {"O1002", "O1005", "O1006"}


def test_filter_by_status_unknown_raises(service):
    """ORDER-REQ-004：非法状态值必须抛 ValueError。"""
    import pytest

    with pytest.raises(ValueError):
        service.list_orders(status="refunded")


def test_filter_by_min_amount_inclusive(service):
    """ORDER-REQ-005：min_amount 为闭区间下界（>=）。"""
    orders = service.list_orders(min_amount=Decimal("128.50"))
    assert _ids(orders) == {"O1003", "O1004", "O1008"}


def test_filter_combines_customer_and_status(service):
    """ORDER-REQ-004/001：条件之间取交集。"""
    orders = service.list_orders(customer_id="C001", status="paid")
    assert _ids(orders) == {"O1001", "O1008"}


def test_filter_preserves_insert_order(service):
    """ORDER-REQ-006：过滤后仍需保持原有顺序。"""
    orders = service.list_orders(status="paid")
    assert [order.order_id for order in orders] == ["O1001", "O1004", "O1007", "O1008"]
