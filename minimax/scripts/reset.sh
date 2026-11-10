#!/usr/bin/env bash
# 重置样例工程与运行记录，回到"修改前"的干净状态
set -euo pipefail
cd "$(dirname "$0")/.."

# 优先用 git 还原（评审环境一般是从仓库 clone 的）；没有 git 时退回基线快照
if git -C .. rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C .. checkout -- minimax/sample_project
  echo "== 已用 git 还原 sample_project"
elif [ -f baseline/service.py ]; then
  cp baseline/service.py sample_project/ordersvc/service.py
  echo "== 非 git 环境，已从 baseline/service.py 还原被改文件"
else
  echo "[warn] 既无 git 也无 baseline 快照，请手动确认 sample_project 未被改动"
fi
rm -f records/context.json records/patch.diff records/minimax_prompt.txt \
      records/minimax_response.txt records/0*_*.log
find sample_project -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf sample_project/.pytest_cache
echo "== 已重置样例工程与 records/（seekdb 中的工件与 PowerContext 状态保留，可重新 ingest 覆盖）"
