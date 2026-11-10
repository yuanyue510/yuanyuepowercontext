#!/usr/bin/env bash
# 无 Key 复现：把 records/patch.diff（MiniMax 当时产出的补丁）重放到基线代码上，
# 验证「修改前 8 failed → 修改后 19 passed」。评审没有 MiniMax Key 时用这条路径核对
# 「代码修改有效」，不依赖模型重新生成补丁。
set -uo pipefail
cd "$(dirname "$0")/.."
if [ -n "${PYTHON:-}" ]; then PY="$PYTHON"
elif command -v python3 >/dev/null 2>&1; then PY=python3
else PY=python; fi

PATCH="${PATCH:-records/patch.diff}"
LOG="records/10_replay_patch.log"
mkdir -p records
[ -f "$PATCH" ] || { echo "[FAIL] 找不到补丁文件 $PATCH"; exit 2; }
[ -f baseline/service.py ] || { echo "[FAIL] 找不到基线快照 baseline/service.py"; exit 2; }

exec > >(tee "$LOG") 2>&1
echo "== 0) 复位到修改前基线"
cp baseline/service.py sample_project/ordersvc/service.py
find sample_project -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
md5sum baseline/service.py sample_project/ordersvc/service.py

echo
echo "== 1) 修改前测试（目标用例应失败）"
( cd sample_project && $PY -m pytest tests -q ) > records/10_replay_before.log 2>&1
BEFORE=$?
tail -2 records/10_replay_before.log
echo "exit=$BEFORE"

echo
echo "== 2) 重放补丁 $PATCH"
export PATCH_FILE="$PATCH"
$PY - <<'PY'
import os
import sys

sys.path.insert(0, os.getcwd())
from sdd_context.patchutil import apply_patch_text, changed_files

path = os.environ.get("PATCH_FILE", "records/patch.diff")
text = open(path, encoding="utf-8").read()
print("涉及文件:", changed_files(text))
ok, msg = apply_patch_text("sample_project", text)
print("应用结果:", ok, "|", msg)
sys.exit(0 if ok else 1)
PY
APPLY=$?
[ "$APPLY" -eq 0 ] || { echo "[FAIL] 补丁应用失败"; exit 1; }

echo
echo "== 3) 修改后测试（应全部通过）"
( cd sample_project && $PY -m pytest tests -q ) > records/10_replay_after.log 2>&1
AFTER=$?
tail -2 records/10_replay_after.log
echo "exit=$AFTER"

echo
echo "== 4) 与记录中的「修改后快照」比对"
if diff -q sample_project/ordersvc/service.py records/snapshot_after_service.py >/dev/null; then
  echo "与 records/snapshot_after_service.py 一致"
  SAME=0
else
  echo "[warn] 与记录快照不一致"
  SAME=1
fi

echo
echo "== 5) 还原到基线（保持工作区为「修改前」状态）"
cp baseline/service.py sample_project/ordersvc/service.py

echo
if [ "$BEFORE" -ne 0 ] && [ "$AFTER" -eq 0 ]; then
  echo "RESULT: PASS —— 修改前 $BEFORE（非 0，目标用例失败）→ 修改后 $AFTER（全部通过）"
  exit "$SAME"
fi
echo "RESULT: FAIL —— 未复现「由红转绿」"
exit 1
