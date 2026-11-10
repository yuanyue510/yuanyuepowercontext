#!/usr/bin/env bash
# 状态复用演示：空状态 → 写入一条任务进度 → 重启上下文模块（PowerContext 服务）
# → 重新读取并使用该状态。全部输出写入 records/08_state_reuse.log
set -uo pipefail

cd "$(dirname "$0")/.."
# 让 powercontext 命令可被找到（conda 环境或自定义安装目录）
[ -d /opt/sdd/miniconda3/bin ] && PATH=/opt/sdd/miniconda3/bin:$PATH && export PATH
if [ -n "${PYTHON:-}" ]; then PY="$PYTHON"
elif command -v python3 >/dev/null 2>&1; then PY=python3
else PY=python; fi

# 默认用带时间戳的任务号：保证每次都是"空状态开始"，脚本可重复执行
TASK_ID="${1:-T-STATE-REUSE-$(date +%Y%m%d%H%M%S)}"
LOG=records/08_state_reuse.log
mkdir -p records
: > "$LOG"
say() { echo "$@" | tee -a "$LOG"; }

say "=== 1) 写入前：确认该任务在 PowerContext 中没有状态 ==="
$PY -m sdd_context state-show --task-id "$TASK_ID" 2>&1 | tee -a "$LOG"
BEFORE=$?
say "state-show 退出码: $BEFORE（1 = 确实为空状态，符合预期）"

say ""
say "=== 2) 保存任务进度（context 已构成、基线测试已跑）==="
$PY -m sdd_context state-save --task-id "$TASK_ID" \
    --stage context_ready \
    --fingerprint "$($PY -c "import json;print(json.load(open('records/context.json'))['context_fingerprint'])" 2>/dev/null || echo unknown)" \
    --completed "导入规格/代码/测试共 46 个工件" \
    --completed "构造任务上下文 context.json" \
    --completed "记录修改前基线测试结果" \
    --todo "调用 MiniMax 生成并应用补丁" \
    --todo "运行目标测试与回归测试" 2>&1 | tee -a "$LOG"
SAVE_RC=$?
say "state-save 退出码: $SAVE_RC"

say ""
say "=== 3) 重启上下文模块（PowerContext 服务停止 + 重新启动）==="
PID=$(pgrep -f "powercontext server run" | head -1)
if [ -n "${PID:-}" ]; then
  say "停止旧进程 pid=$PID"
  kill -9 "$PID" 2>/dev/null
fi
sleep 2
nohup powercontext server run >> /opt/sdd/pcdata/server.log 2>&1 &
say "已重新启动 PowerContext，等待就绪..."
for i in $(seq 1 60); do
  if curl -s -m 2 http://127.0.0.1:8000/v1/capabilities > /dev/null 2>&1; then
    say "服务就绪（第 ${i} 次探测）"
    break
  fi
  sleep 1
done
NEWPID=$(pgrep -f "powercontext server run" | head -1)
say "新进程 pid=${NEWPID:-未知}（与旧进程不同即证明是重启后的新进程）"

say ""
say "=== 4) 重启后读取该状态 ==="
$PY -m sdd_context state-show --task-id "$TASK_ID" 2>&1 | tee -a "$LOG"
SHOW_RC=$?
say "state-show 退出码: $SHOW_RC"

say ""
if [ "$SHOW_RC" -eq 0 ] && [ "$BEFORE" -ne 0 ]; then
  say "RESULT: PASS —— 空状态写入 → 服务重启 → 状态可读回"
  exit 0
fi
say "RESULT: FAIL —— 状态未能跨重启复用"
exit 1
