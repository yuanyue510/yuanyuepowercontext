#!/usr/bin/env bash
# MiniMax 连通性与额度自检：确认 Key、模型名、可用端点，不消耗大量 token。
# 用法：MINIMAX_API_KEY=sk-xxx bash scripts/check_minimax.sh [model]
set -uo pipefail
cd "$(dirname "$0")/.."
if [ -n "${PYTHON:-}" ]; then PY="$PYTHON"
elif command -v python3 >/dev/null 2>&1; then PY=python3
else PY=python; fi

MODEL="${1:-${MINIMAX_MODEL:-MiniMax-M3}}"
if [ -z "${MINIMAX_API_KEY:-}" ] && [ -f .env ]; then
  MINIMAX_API_KEY=$(grep -E '^MINIMAX_API_KEY=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')
  export MINIMAX_API_KEY
fi
if [ -z "${MINIMAX_API_KEY:-}" ]; then
  echo "[FAIL] 未设置 MINIMAX_API_KEY（可写入 .env）"; exit 2
fi
export MM_MODEL="$MODEL"
export MM_BASE="${MINIMAX_BASE_URL:-https://api.minimax.chat}"

$PY - <<'PY'
import json, os, urllib.error, urllib.request

key = os.environ["MINIMAX_API_KEY"]
base = os.environ["MM_BASE"].rstrip("/")
model = os.environ["MM_MODEL"]


def http(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data,
                                 method="POST" if body else "GET",
                                 headers={"Authorization": "Bearer " + key,
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}
    except Exception as e:
        return -1, {"error": f"{type(e).__name__}: {e}"}


code, payload = http("/v1/models")
ids = [m["id"] for m in (payload.get("data") or [])] if code == 200 else []
print(f"1) 鉴权 /v1/models -> HTTP {code}，可见模型 {len(ids)} 个")
if ids:
    print("   " + ", ".join(ids[:10]))

code, payload = http("/v1/text/chatcompletion_v2", {
    "model": model,
    "messages": [{"role": "user", "content": "ping"}],
    "max_tokens": 8,
})
br = payload.get("base_resp") or {}
status = br.get("status_code")
msg = br.get("status_msg")
print(f"2) 调用 {model} -> HTTP {code} base_resp={status} {msg!r}")
if payload.get("choices"):
    print("   返回内容:", (payload["choices"][0].get("message") or {}).get("content", "")[:80])
    print("RESULT: PASS —— Key 可用，模型可调用")
    raise SystemExit(0)
if status == 1008:
    print("RESULT: FAIL —— 账户额度不足（insufficient balance 1008），需充值或启用 Token Plan")
elif status == 2069:
    print(f"RESULT: FAIL —— 模型 {model} 已下线，请换用 /v1/models 中的在售模型")
else:
    print("RESULT: FAIL —— 调用未返回内容，请查看上方的 base_resp")
raise SystemExit(1)
PY
