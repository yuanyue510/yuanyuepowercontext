"""用 MiniMax 完成代码修改。

流程：读取上下文模块产出的 context.json → 组装提示词（规格 + 现有代码 + 必过测试）
→ 调用 MiniMax 对话接口 → 解析 unified diff → 落盘补丁并应用。

所有请求与响应都会写入 records/minimax_log.jsonl，作为"MiniMax 实际参与"的记录。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
MINIMAX_DIR = os.path.dirname(HERE)
sys.path.insert(0, MINIMAX_DIR)

from sdd_context.config import Config  # noqa: E402

SYSTEM_PROMPT = """你是遵循规格驱动开发（SDD）的资深 Python 工程师。

规则：
1. 只修改「需要修改的代码」里给出的文件，不要新建文件；
2. 严禁修改任何测试文件（tests/ 下的内容），测试是验收标准；
3. 必须逐条满足「适用规格」，同时不得破坏「验证测试」里标注为 regression 的既有行为；
4. 金额计算必须使用 Decimal，禁止 float 相加；
5. 只输出 unified diff（diff --git 或 ---/+++ 开头的补丁），不要输出解释、不要用代码块包裹以外的内容。
"""


# --------------------------------------------------------------------- 提示词
def build_prompt(context: Dict[str, Any]) -> str:
    task = context["task"]
    specs = context.get("specs", [])
    code = context.get("code", [])
    tests = context.get("tests", [])

    parts: List[str] = [f"# 开发任务\n{task}\n"]
    parts.append("# 必须遵守的规格（来自 seekdb，含来源行号）")
    for s in specs:
        parts.append(f"\n## [{s['id']}] {s['title']}\n来源: {s['path']}:{s['line']}\n\n{s['body']}")

    parts.append("\n# 需要修改的代码（当前版本，按文件+符号给出）")
    for c in code:
        parts.append(
            f"\n## 文件 {c['path']} 符号 {c['symbol']} "
            f"(第 {c['start_line']}-{c['end_line']} 行)\n```python\n{c['source']}\n```"
        )

    parts.append("\n# 验证测试（修改后必须通过，且不允许改动测试）")
    for t in tests:
        parts.append(f"- [{t['role']}] {t['node_id']} — {t['purpose']}")

    target_sources = [t for t in tests if t.get("role") == "target" and t.get("source")]
    if target_sources:
        parts.append("\n## 目标测试源码（这些断言就是验收标准）")
        for t in target_sources:
            parts.append(f"\n### {t['node_id']}\n```python\n{t['source']}\n```")

    parts.append(
        "\n# 输出要求\n"
        "给出可直接 `patch -p1` 应用的 unified diff；路径相对样例工程根目录"
        "（例如 ordersvc/service.py）。只输出补丁本身。"
    )
    return "\n".join(parts)


# --------------------------------------------------------------------- 调用
def _http_json(url: str, body: dict, headers: dict, timeout: int = 240):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def call_minimax(cfg: Config, prompt: str, temperature: float = 0.1) -> Dict[str, Any]:
    """调用 MiniMax，兼容 chatcompletion_v2 / OpenAI 兼容 / Anthropic 兼容三种形态。

    返回 {text, usage, raw, style, elapsed_ms, url}；全部失败时抛 RuntimeError。
    """
    style_opt = os.environ.get("MINIMAX_API_STYLE", "auto").strip().lower()
    if style_opt in ("", "auto"):
        # sk-cp- 是 Token Plan 订阅 Key，官方推荐 Anthropic 兼容端点，优先尝试
        if cfg.minimax_api_key.startswith("sk-cp"):
            styles = ["anthropic", "openai", "chatcompletion_v2"]
        else:
            styles = ["chatcompletion_v2", "openai", "anthropic"]
    else:
        styles = [style_opt]

    base = cfg.minimax_base_url.rstrip("/")
    auth = f"Bearer {cfg.minimax_api_key}"
    last_error: Optional[str] = None

    for style in styles:
        if style == "anthropic":
            url = f"{base}/v1/messages" if base.endswith("/anthropic") else f"{base}/anthropic/v1/messages"
            body = {
                "model": cfg.minimax_model,
                "max_tokens": 8192,
                "temperature": temperature,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": prompt}],
            }
            headers = {
                "Content-Type": "application/json",
                "x-api-key": cfg.minimax_api_key,
                "anthropic-version": "2023-06-01",
                "Authorization": auth,
            }
        elif style == "chatcompletion_v2":
            url = f"{base}/v1/text/chatcompletion_v2"
            if cfg.minimax_group_id:
                url += f"?GroupId={cfg.minimax_group_id}"
            body = {
                "model": cfg.minimax_model,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                "temperature": temperature,
                "max_tokens": 8192,
            }
            headers = {"Content-Type": "application/json", "Authorization": auth}
        else:                                  # openai
            url = f"{base}/v1/chat/completions"
            body = {
                "model": cfg.minimax_model,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                "temperature": temperature,
                "max_tokens": 8192,
            }
            headers = {"Content-Type": "application/json", "Authorization": auth}

        started = time.time()
        try:
            payload = _http_json(url, body, headers)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            last_error = f"{style}: HTTP {exc.code} {detail}"
            continue
        except urllib.error.URLError as exc:
            last_error = f"{style}: {exc}"
            continue
        except json.JSONDecodeError as exc:
            last_error = f"{style}: 响应不是 JSON（{exc}）"
            continue

        # 旧端点的业务错误放在 base_resp 里，HTTP 状态仍是 200
        base_resp = payload.get("base_resp") or {}
        if base_resp.get("status_code") not in (None, 0):
            last_error = (f"{style}: {base_resp.get('status_code')} "
                          f"{base_resp.get('status_msg')}")
            continue

        if style == "anthropic":
            blocks = payload.get("content") or []
            text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
            usage = payload.get("usage") or {}
        else:
            choices = payload.get("choices") or []
            if not choices:
                last_error = f"{style}: 返回没有 choices（{str(payload)[:200]}）"
                continue
            text = (choices[0].get("message") or {}).get("content") or ""
            usage = payload.get("usage") or {}

        if not text.strip():
            last_error = f"{style}: 返回内容为空"
            continue

        return {
            "text": text,
            "usage": usage,
            "raw": payload,
            "style": style,
            "elapsed_ms": round((time.time() - started) * 1000, 1),
            "url": url,
        }

    raise RuntimeError(f"MiniMax 调用失败：{last_error}")


# --------------------------------------------------------------------- 补丁
def extract_patch(text: str) -> str:
    """从模型回复里抠出 unified diff。"""
    fenced = re.findall(r"```(?:diff|patch)?\n(.*?)```", text, flags=re.S)
    for block in fenced:
        if "---" in block and "+++" in block:
            return block.strip() + "\n"
    idx = text.find("diff --git")
    if idx >= 0:
        return text[idx:].strip() + "\n"
    idx = text.find("--- ")
    if idx >= 0:
        return text[idx:].strip() + "\n"
    return ""


def apply_patch(project_dir: str, patch_text: str) -> Tuple[bool, str]:
    """先用内置 Python 应用器（零依赖），失败再退回 patch / git apply。"""
    from sdd_context.patchutil import apply_patch_text

    ok, message = apply_patch_text(project_dir, patch_text)
    if ok:
        return True, "python-applier: " + message

    notes = ["python-applier 失败: " + message]
    patch_file = os.path.join(project_dir, ".sdd_patch.diff")
    with open(patch_file, "w", encoding="utf-8") as fh:
        fh.write(patch_text)
    try:
        for cmd in (["patch", "-p1", "--forward", "--batch", "-i", ".sdd_patch.diff"],):
            try:
                proc = subprocess.run(cmd, cwd=project_dir, capture_output=True, text=True)
            except FileNotFoundError:
                notes.append(f"{cmd[0]}: 未安装")
                continue
            if proc.returncode == 0:
                return True, f"{cmd[0]}: " + (proc.stdout.strip() or "ok")
            notes.append(f"{cmd[0]}: {proc.stdout.strip() or proc.stderr.strip()}"[:300])
        return False, " | ".join(notes)
    finally:
        if os.path.exists(patch_file):
            os.remove(patch_file)


# --------------------------------------------------------------------- 记录
def log_record(path: str, record: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def _snapshot(project_dir: str) -> Dict[str, str]:
    """快照 ordersvc/ 下全部 Python 文件。

    不按补丁里声明的路径取快照：模型偶尔会把 ---/+++ 头写坏，声明路径是垃圾值，
    按声明取快照会漏掉真正被改的文件，回滚时留下脏数据。
    """
    snap: Dict[str, str] = {}
    root = os.path.join(project_dir, "ordersvc")
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if not name.endswith(".py"):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, project_dir)
            with open(full, encoding="utf-8") as fh:
                snap[rel] = fh.read()
    return snap


def _restore(project_dir: str, snap: Dict[str, str]) -> None:
    for rel, text in snap.items():
        with open(os.path.join(project_dir, rel), "w", encoding="utf-8") as fh:
            fh.write(text)


def _run(cmd: str, cwd: str) -> Tuple[int, str]:
    proc = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)
    return proc.returncode, ((proc.stdout or "") + (proc.stderr or "")).strip()


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="用 MiniMax 依据上下文修改代码")
    parser.add_argument("--context", required=True, help="context.json 路径")
    parser.add_argument("--project", default=os.path.join(MINIMAX_DIR, "sample_project"))
    parser.add_argument("--out-patch", default=os.path.join(MINIMAX_DIR, "records", "patch.diff"))
    parser.add_argument("--apply", action="store_true", help="应用补丁到样例工程")
    parser.add_argument("--verify-cmd", default="", help="应用后自检命令；失败则带上报错重试")
    parser.add_argument("--max-attempts", type=int, default=3, help="最多尝试次数")
    parser.add_argument("--temperature", type=float, default=0.1)
    parser.add_argument("--dry-run", action="store_true", help="只打印提示词，不调用模型")
    args = parser.parse_args(argv)

    cfg = Config.from_env()
    context = json.load(open(args.context, encoding="utf-8"))
    base_prompt = build_prompt(context)

    if args.dry_run:
        print(base_prompt)
        return 0

    if not cfg.minimax_api_key:
        print("[error] 未配置 MINIMAX_API_KEY，无法调用 MiniMax", file=sys.stderr)
        return 2

    os.makedirs(cfg.records_dir, exist_ok=True)
    prompt_path = os.path.join(cfg.records_dir, "minimax_prompt.txt")
    with open(prompt_path, "w", encoding="utf-8") as fh:
        fh.write(base_prompt)

    log_path = os.path.join(cfg.records_dir, "minimax_log.jsonl")
    print(f"[minimax] model={cfg.minimax_model} base={cfg.minimax_base_url} "
          f"prompt_chars={len(base_prompt)} max_attempts={args.max_attempts}")

    feedback = ""
    attempts: List[Dict[str, Any]] = []

    for attempt in range(1, args.max_attempts + 1):
        prompt = base_prompt + (("\n\n# 上一轮结果与修正要求\n" + feedback) if feedback else "")
        print(f"[minimax] 第 {attempt} 次调用，prompt_chars={len(prompt)}")
        try:
            result = call_minimax(cfg, prompt, temperature=args.temperature)
        except RuntimeError as exc:
            record = {"ts": _now(), "attempt": attempt, "status": "call_failed",
                      "error": str(exc)[:600], "model": cfg.minimax_model}
            log_record(log_path, record)
            print(f"[error] {exc}", file=sys.stderr)
            return 5

        print(f"[minimax] style={result['style']} elapsed={result['elapsed_ms']}ms "
              f"usage={result['usage']}")

        resp_path = os.path.join(cfg.records_dir,
                                 "minimax_response.txt" if attempt == 1
                                 else f"minimax_response_{attempt}.txt")
        with open(resp_path, "w", encoding="utf-8") as fh:
            fh.write(result["text"])

        patch = extract_patch(result["text"])
        record: Dict[str, Any] = {
            "ts": _now(),
            "attempt": attempt,
            "task": context.get("task"),
            "context_fingerprint": context.get("context_fingerprint"),
            "spec_ids": [s["id"] for s in context.get("specs", [])],
            "code_targets": [c["artifact_id"] for c in context.get("code", [])],
            "model": cfg.minimax_model,
            "api_style": result["style"],
            "prompt_path": prompt_path,
            "prompt_chars": len(prompt),
            "usage": result["usage"],
            "elapsed_ms": result["elapsed_ms"],
            "patch_chars": len(patch),
            "response_path": resp_path,
            "response_head": result["text"][:600],
        }

        if not patch:
            record["status"] = "no_patch"
            attempts.append(record)
            log_record(log_path, record)
            feedback = ("你上一轮的回复里没有可以解析的 unified diff。"
                        "请只输出补丁本身，形如：\n--- a/ordersvc/service.py\n"
                        "+++ b/ordersvc/service.py\n@@ -12,7 +12,9 @@")
            continue

        with open(args.out_patch, "w", encoding="utf-8") as fh:
            fh.write(patch)
        record["patch_path"] = args.out_patch
        record["patch"] = patch

        if not args.apply:
            record["status"] = "patch_saved"
            attempts.append(record)
            log_record(log_path, record)
            print(f"[patch] 已保存到 {args.out_patch}")
            return 0

        snap = _snapshot(args.project)

        ok, message = apply_patch(args.project, patch)
        record["applied"] = ok
        record["apply_message"] = message[:600]

        if not ok:
            _restore(args.project, snap)
            record["status"] = "apply_failed"
            attempts.append(record)
            log_record(log_path, record)
            print(f"[patch] 应用失败: {message[:200]}")
            feedback = ("上一轮补丁应用失败：" + message[:400] +
                        "\n请重新输出完整的 unified diff：文件头必须是\n"
                        "--- a/ordersvc/service.py\n+++ b/ordersvc/service.py\n"
                        "不要写省略号、不要省略文件路径；上下文行必须与给出的当前代码逐字符一致。")
            continue

        print(f"[patch] 应用成功: {message[:200]}")

        if not args.verify_cmd:
            record["status"] = "applied"
            attempts.append(record)
            log_record(log_path, record)
            return 0

        rc, out = _run(args.verify_cmd, args.project)
        record["verify_cmd"] = args.verify_cmd
        record["verify_exit"] = rc
        record["verify_tail"] = out[-1200:]
        with open(os.path.join(cfg.records_dir, f"minimax_verify_attempt{attempt}.log"),
                  "w", encoding="utf-8") as fh:
            fh.write(out)

        if rc == 0:
            record["status"] = "verified"
            attempts.append(record)
            log_record(log_path, record)
            print(f"[verify] 自检通过（attempt {attempt}）")
            return 0

        _restore(args.project, snap)
        record["status"] = "verify_failed"
        attempts.append(record)
        log_record(log_path, record)
        print(f"[verify] 自检失败 rc={rc}，已回滚本次修改")
        feedback = ("上一轮补丁能应用，但自检命令 `" + args.verify_cmd +
                    "` 失败，输出末尾如下：\n" + out[-1500:] +
                    "\n请修正实现后重新输出完整补丁。")

    print(f"[error] {args.max_attempts} 次尝试均未得到可用补丁，详见 {log_path}",
          file=sys.stderr)
    return 4


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


if __name__ == "__main__":
    raise SystemExit(main())
