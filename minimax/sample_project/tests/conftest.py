import pytest

from ordersvc.repository import OrderRepository
from ordersvc.service import OrderService


@pytest.fixture()
def service() -> OrderService:
    """每个用例一份干净的仓库，避免用例间互相污染。"""
    return OrderService(OrderRepository())
