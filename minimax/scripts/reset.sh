#!/usr/bin/env bash
# 重置样例工程与运行记录，回到"修改前"的干净状态
set -euo pipefail
cd "$(dirname "$0")/.."

git -C .. checkout -- minimax/sample_project 2>/dev/null || {
  echo "[warn] 非 git 环境，无法用 git 还原；请确认 sample_project 未被改动"
}
rm -f records/context.json records/patch.diff records/minimax_prompt.txt \
      records/minimax_response.txt records/0*_*.log
find sample_project -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf sample_project/.pytest_cache
echo "== 已重置样例工程与 records/（seekdb 中的工件与 PowerContext 状态保留，可重新 ingest 覆盖）"
