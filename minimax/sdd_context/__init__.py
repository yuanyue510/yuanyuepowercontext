"""SDD 工程上下文模块（context module）。

对外只暴露一个入口：``build_context(task)`` —— 给一句开发任务描述，
返回"适用规格 + 需要改的代码 + 需要跑的测试"以及每条内容的来源。
"""

from .config import Config
from .retrieve import ContextBundle, build_context

__all__ = ["Config", "ContextBundle", "build_context"]
__version__ = "0.1.0"
