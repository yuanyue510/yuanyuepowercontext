#!/usr/bin/env bash
# 规格变更演示：证明上下文不是固定答案——规格改了，重新导入后上下文正文与指纹随之变化。
set -uo pipefail
cd "$(dirname "$0")/.."

# 解释器探测：优先 PYTHON 环境变量，其次 python3，最后 python
if [ -n "${PYTHON:-}" ]; then
  PY="$PYTHON"
elif command -v python3 >/dev/null 2>&1; then
  PY=python3
else
  PY=python
fi
TASK="${TASK:-为订单查询增加状态过滤与最低金额过滤，并修复金额汇总的浮点误差}"
SPEC="sample_project/specs/order-query.md"
BAK="$(mktemp)"
LOG="records/06_spec_update.log"

cleanup() {
  cp -f "$BAK" "$SPEC"
  rm -f "$BAK"
  $PY -m sdd_context ingest --root sample_project >/dev/null 2>&1
}
trap cleanup EXIT

mkdir -p records
exec > >(tee "$LOG") 2>&1

echo "== 1) 变更前上下文"
$PY -m sdd_context context --task "$TASK" --out records/spec_before.json >/dev/null
$PY - <<'PY'
import json
c = json.load(open('records/spec_before.json', encoding='utf-8'))
s = next(x for x in c['specs'] if x['id'] == 'ORDER-REQ-005')
print('fingerprint:', c['context_fingerprint'])
print('ORDER-REQ-005 正文首句:', s['body'].splitlines()[0])
PY

echo
echo "== 2) 修改规格：ORDER-REQ-005 由「大于等于」改为「严格大于」"
cp -f "$SPEC" "$BAK"
$PY - "$SPEC" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
old = "必须筛出金额 **大于等于** `min_amount` 的订单（闭区间下界）。"
new = "必须筛出金额 **严格大于** `min_amount` 的订单（开区间，等于下界的订单被排除）。"
assert old in text, "规格原文未找到，演示脚本需要更新"
open(path, 'w', encoding='utf-8').write(text.replace(old, new))
print('已替换规格正文')
PY

echo
echo "== 3) 重新导入并重建上下文"
$PY -m sdd_context ingest --root sample_project | tail -1
$PY -m sdd_context context --task "$TASK" --out records/spec_after.json >/dev/null
$PY - <<'PY'
import json
b = json.load(open('records/spec_before.json', encoding='utf-8'))
a = json.load(open('records/spec_after.json', encoding='utf-8'))
sb = next(x for x in b['specs'] if x['id'] == 'ORDER-REQ-005')
sa = next(x for x in a['specs'] if x['id'] == 'ORDER-REQ-005')
print('fingerprint before:', b['context_fingerprint'])
print('fingerprint after :', a['context_fingerprint'])
print('revision  before:', sb['revision'])
print('revision  after :', sa['revision'])
print('ORDER-REQ-005 正文首句 after:', sa['body'].splitlines()[0])
assert sa['body'] != sb['body'], '上下文正文未变化'
assert a['context_fingerprint'] != b['context_fingerprint'], '上下文指纹未变化'
print('[PASS] 规格更新后，上下文使用了新内容')
PY
RC=$?

echo
echo "== 4) 还原规格并重新导入"
echo "演示结束，退出码 $RC"
