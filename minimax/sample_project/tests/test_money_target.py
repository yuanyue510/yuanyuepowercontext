"""目标功能测试（金额侧）—— 覆盖 ORDER-REQ-007。

修改前的实现用 float 累加、再乘 100 取整，分位会被截断：
  0.01 + 2.00  -> 200.99999999999997 -> 200 分（应为 201）
  0.01 + 1.13  -> 113.99999999999999 -> 113 分（应为 114）
因此本文件用例在修改前必须失败，修改后必须通过。
"""


def test_total_cents_no_truncation_small_amounts(service):
    """ORDER-REQ-007：0.01 + 2.00 必须精确等于 201 分。"""
    assert service.total_cents(["O1002", "O1006"]) == 201


def test_total_cents_no_truncation_odd_cents(service):
    """ORDER-REQ-007：0.01 + 1.13 必须精确等于 114 分。"""
    assert service.total_cents(["O1002", "O1007"]) == 114
