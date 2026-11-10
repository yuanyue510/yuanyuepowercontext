"""支持 `python -m sdd_context <command>` 的调用形式。"""

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
