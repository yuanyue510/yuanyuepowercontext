#!/usr/bin/env bash
# 端到端验证：导入资料 → 构造上下文 → 基线测试（应失败）→ MiniMax 改代码
#             → 测试（应通过）→ 保存任务状态 → 新进程读回状态
#
# 用法：bash scripts/verify.sh            # 完整流程
#       SKIP_MINIMAX=1 bash scripts/verify.sh   # 只跑到上下文与基线测试
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
TASK_ID="${TASK_ID:-T-ORDER-FILTER}"
SCOPE_TITLE="${SCOPE_TITLE:-sdd-context-demo}"
mkdir -p records

LOG="records/verify_$(date +%Y%m%dT%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
FAIL=0

hdr() { printf '\n\033[1m==== %s ====\033[0m\n' "$*"; }
ok()  { printf '\033[32m[PASS]\033[0m %s\n' "$*"; }
bad() { printf '\033[31m[FAIL]\033[0m %s\n' "$*"; FAIL=1; }

hdr "0/8 环境检查"
$PY -V
$PY -c "import pymysql, pytest; print('deps ok: pymysql', pymysql.__version__)" || { bad "缺少依赖，先跑 scripts/setup.sh"; exit 1; }
$PY -c "
import os, pymysql
c = pymysql.connect(host=os.environ.get('SDD_DB_HOST','127.0.0.1'),
                    port=int(os.environ.get('SDD_DB_PORT','2881')),
                    user=os.environ.get('SDD_DB_USER','root'),
                    password=os.environ.get('SDD_DB_PASSWORD',''))
with c.cursor() as cur:
    cur.execute('select version()')
    print('seekdb ok:', cur.fetchone()[0])
c.close()
" || { bad "seekdb 连接失败"; exit 1; }

hdr "1/8 初始化 seekdb 结构与索引"
$PY -m sdd_context init-db || { bad "init-db 失败"; exit 1; }
ok "seekdb schema 就绪"

hdr "2/8 导入规格 / 代码 / 测试"
$PY -m sdd_context ingest --root sample_project || { bad "ingest 失败"; exit 1; }
ok "资料入库完成"

hdr "3/8 为任务构造上下文"
$PY -m sdd_context context --task "$TASK" --out records/context.json || { bad "context 失败"; exit 1; }
if $PY - <<'PY'
import json, sys
ctx = json.load(open('records/context.json', encoding='utf-8'))
ids = [s['id'] for s in ctx['specs']]
need = ['ORDER-REQ-004', 'ORDER-REQ-005', 'ORDER-REQ-007']
missing = [n for n in need if n not in ids]
print('命中规格:', ids)
print('代码目标:', ['%s#%s' % (c['path'], c['symbol']) for c in ctx['code']])
print('测试用例:', len(ctx['tests']), '条')
sys.exit(1 if missing else 0)
PY
then
  ok "上下文包含必要规格与来源"
else
  bad "上下文缺少必要规格"
fi

hdr "4/8 基线测试（修改前，目标用例应失败）"
# 先记录测试文件指纹，最后用来证明测试零改动
( cd sample_project && find tests -name '*.py' -print0 | sort -z | xargs -0 sha256sum ) > records/00_tests_hash_before.txt
cp -f sample_project/ordersvc/service.py records/snapshot_before_service.py
echo "测试文件指纹: records/00_tests_hash_before.txt"
echo "修改前代码快照: records/snapshot_before_service.py"
( cd sample_project && $PY -m pytest tests -q ) > records/01_before_tests.log 2>&1
BEFORE_RC=$?
echo "pytest exit=$BEFORE_RC"
tail -12 records/01_before_tests.log
if [ "$BEFORE_RC" -eq 0 ]; then
  bad "修改前测试全部通过——目标行为可能已实现，无法验证"
else
  if grep -qE 'test_(query|money)_target\.py' records/01_before_tests.log; then
    ok "目标测试如预期失败（功能未实现），$BEFORE_RC != 0"
  else
    bad "失败原因不在目标用例，可能是环境问题"
  fi
fi

if [ "${SKIP_MINIMAX:-0}" = "1" ]; then
  hdr "已按 SKIP_MINIMAX=1 跳过 MiniMax"
  exit $FAIL
fi

hdr "5/8 MiniMax 依据上下文修改代码"
if [ -z "${MINIMAX_API_KEY:-}" ]; then
  bad "未设置 MINIMAX_API_KEY，跳过代码修改。设置后重跑即可。"
  exit 1
fi
$PY agent/minimax_patch.py --context records/context.json --project sample_project \
    --out-patch records/patch.diff --apply || { bad "MiniMax 修改失败"; exit 1; }
ok "补丁已应用"
cp -f sample_project/ordersvc/service.py records/snapshot_after_service.py
echo "修改后代码快照: records/snapshot_after_service.py"
echo '--- patch 摘要 ---'
grep -E '^(---|\+\+\+|@@)' records/patch.diff | head -20 || true

hdr "6/8 修改后测试（目标 + 回归，应全部通过）"
( cd sample_project && $PY -m pytest tests -q ) > records/03_after_tests.log 2>&1
AFTER_RC=$?
echo "pytest exit=$AFTER_RC"
tail -6 records/03_after_tests.log
if [ "$AFTER_RC" -eq 0 ]; then ok "全部测试通过"; else bad "修改后仍有测试失败"; fi
# 用哈希证明测试文件零改动
( cd sample_project && find tests -name '*.py' -print0 | sort -z | xargs -0 sha256sum ) > records/00_tests_hash_after.txt
if diff -q records/00_tests_hash_before.txt records/00_tests_hash_after.txt >/dev/null; then
  ok "测试文件未被改动（指纹一致）"
else
  bad "测试文件被改动，违反验收约束"
  diff records/00_tests_hash_before.txt records/00_tests_hash_after.txt | head -10
fi

hdr "7/8 保存任务状态到 PowerContext"
$PY - "$TASK_ID" "$BEFORE_RC" "$AFTER_RC" "$SCOPE_TITLE" <<'PY'
import json, re, sys
from sdd_context.config import Config
from sdd_context.pc_client import PowerContext
from sdd_context.state import TaskState, Verification, save_state, save_evidence

task_id, before_rc, after_rc, scope_title = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]

def counts(path):
    txt = open(path, encoding='utf-8', errors='replace').read()
    m = re.search(r'(\d+) failed', txt)
    failed = int(m.group(1)) if m else 0
    m = re.search(r'(\d+) passed', txt)
    passed = int(m.group(1)) if m else 0
    return passed, failed

b_pass, b_fail = counts('records/01_before_tests.log')
a_pass, a_fail = counts('records/03_after_tests.log')
ctx = json.load(open('records/context.json', encoding='utf-8'))

pc = PowerContext(Config.from_env())
pc.ensure_scope(title=scope_title, summary='SDD 上下文管理系统的任务状态')
ev = save_evidence(pc, task_id, 'after-tests', open('records/03_after_tests.log', encoding='utf-8', errors='replace').read(),
                   {'task_id': task_id, 'stage': 'after'})

state = TaskState(
    task_id=task_id,
    stage='verified',
    completed=[
        '导入 specs/code/tests 到 seekdb',
        '构造任务上下文（规格 ORDER-REQ-004/005/007）',
        'MiniMax 生成补丁并应用',
        '目标测试与回归测试全部通过',
    ],
    todo=[],
    verifications=[
        Verification(name='before', command='pytest tests -q',
                     exit_code=before_rc, passed=b_pass, failed=b_fail,
                     note='修改前目标用例失败'),
        Verification(name='after', command='pytest tests -q',
                     exit_code=after_rc, passed=a_pass, failed=a_fail,
                     note='修改后全部通过'),
    ],
    context_fingerprint=ctx.get('context_fingerprint', ''),
    evidence_source_id=ev,
)
save_state(pc, state)
print(f'state saved: scope={pc.scope_id} task={task_id}')
PY
[ $? -eq 0 ] && ok "任务状态已写入 PowerContext" || bad "状态保存失败"

hdr "8/8 新进程读回任务状态（验证状态复用）"
$PY -m sdd_context state-show --task-id "$TASK_ID" --scope-title "$SCOPE_TITLE"
[ $? -eq 0 ] && ok "重启后成功读取状态" || bad "状态读取失败"

hdr "结果"
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m全部步骤通过\033[0m  日志: %s\n' "$LOG"
else
  printf '\033[31m存在失败步骤，请查看日志: %s\033[0m\n' "$LOG"
fi
exit $FAIL
