#!/usr/bin/env bash
# 环境准备：安装 Python 依赖（要求 Python 3.11+）
set -euo pipefail
cd "$(dirname "$0")/.."

# 解释器探测：优先 PYTHON 环境变量，其次 python3，最后 python
if [ -n "${PYTHON:-}" ]; then
  PY="$PYTHON"
elif command -v python3 >/dev/null 2>&1; then
  PY=python3
else
  PY=python
fi
echo "== Python: $($PY -V 2>&1)"
$PY -m pip install --quiet --upgrade pip || true
$PY -m pip install --quiet -r requirements.txt
echo "== 依赖安装完成"
echo "下一步："
echo "  1) cp .env.example .env 并按实际情况填写（seekdb / MiniMax / PowerContext）"
echo "  2) powercontext server run   # 另开终端，启动任务状态服务"
echo "  3) bash scripts/verify.sh"
