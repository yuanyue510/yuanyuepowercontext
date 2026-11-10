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
def call_minimax(cfg: Config, prompt: str, temperature: float = 0.1) -> Dict[str, Any]:
    """调用 MiniMax 对话接口，兼容两种常见形态，返回 {text, usage, raw, style}。"""
    styles = [os.environ.get("MINIMAX_API_STYLE", "auto")]
    if styles[0] == "auto":
        styles = ["chatcompletion_v2", "openai"]

    last_error: Optional[str] = None
    for style in styles:
        if style == "chatcompletion_v2":
            url = f"{cfg.minimax_base_url}/v1/text/chatcompletion_v2"
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
        else:
            url = f"{cfg.minimax_base_url}/v1/chat/completions"
            body = {
                "model": cfg.minimax_model,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                "temperature": temperature,
                "max_tokens": 8192,
            }

        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            url, data=data, method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {cfg.minimax_api_key}",
            },
        )
        started = time.time()
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            last_error = f"{style}: HTTP {exc.code} {detail}"
            continue
        except urllib.error.URLError as exc:
            last_error = f"{style}: {exc}"
            continue

        if payload.get("base_resp", {}).get("status_code") not in (None, 0):
            last_error = f"{style}: business error {payload.get('base_resp')}"
            continue

        choices = payload.get("choices") or []
        if not choices:
            last_error = f"{style}: empty choices {payload}"
            continue
        message = choices[0].get("message", {})
        text = message.get("content") or ""
        return {
            "text": text,
            "usage": payload.get("usage", {}),
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
    patch_file = os.path.join(project_dir, ".sdd_patch.diff")
    with open(patch_file, "w", encoding="utf-8") as fh:
        fh.write(patch_text)
    try:
        for cmd in (["patch", "-p1", "--forward", "--batch", "-i", ".sdd_patch.diff"],
                    ["patch", "-p0", "--forward", "--batch", "-i", ".sdd_patch.diff"]):
            proc = subprocess.run(cmd, cwd=project_dir, capture_output=True, text=True)
            if proc.returncode == 0:
                return True, proc.stdout.strip() or proc.stderr.strip()
            last = proc.stdout + proc.stderr
        return False, last
    finally:
        if os.path.exists(patch_file):
            os.remove(patch_file)


# --------------------------------------------------------------------- 记录
def log_record(path: str, record: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="用 MiniMax 依据上下文修改代码")
    parser.add_argument("--context", required=True, help="context.json 路径")
    parser.add_argument("--project", default=os.path.join(MINIMAX_DIR, "sample_project"))
    parser.add_argument("--out-patch", default=os.path.join(MINIMAX_DIR, "records", "patch.diff"))
    parser.add_argument("--apply", action="store_true", help="应用补丁到样例工程")
    parser.add_argument("--temperature", type=float, default=0.1)
    parser.add_argument("--dry-run", action="store_true", help="只打印提示词，不调用模型")
    args = parser.parse_args(argv)

    cfg = Config.from_env()
    context = json.load(open(args.context, encoding="utf-8"))
    prompt = build_prompt(context)

    if args.dry_run:
        print(prompt)
        return 0

    if not cfg.minimax_api_key:
        print("[error] 未配置 MINIMAX_API_KEY，无法调用 MiniMax", file=sys.stderr)
        return 2

    prompt_path = os.path.join(cfg.records_dir, "minimax_prompt.txt")
    os.makedirs(cfg.records_dir, exist_ok=True)
    open(prompt_path, "w", encoding="utf-8").write(prompt)

    print(f"[minimax] model={cfg.minimax_model} base={cfg.minimax_base_url} "
          f"prompt_chars={len(prompt)}")
    result = call_minimax(cfg, prompt, temperature=args.temperature)
    print(f"[minimax] style={result['style']} elapsed={result['elapsed_ms']}ms "
          f"usage={result['usage']}")

    patch = extract_patch(result["text"])
    with open(os.path.join(cfg.records_dir, "minimax_response.txt"), "w", encoding="utf-8") as fh:
        fh.write(result["text"])

    record: Dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
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
        "response_head": result["text"][:400],
    }

    if not patch:
        record["status"] = "no_patch"
        log_record(os.path.join(cfg.records_dir, "minimax_log.jsonl"), record)
        print("[error] 模型回复中未找到 unified diff，原文见 records/minimax_response.txt",
              file=sys.stderr)
        return 3

    os.makedirs(os.path.dirname(args.out_patch) or ".", exist_ok=True)
    with open(args.out_patch, "w", encoding="utf-8") as fh:
        fh.write(patch)
    record["patch_path"] = args.out_patch

    if args.apply:
        ok, message = apply_patch(args.project, patch)
        record["applied"] = ok
        record["apply_message"] = message[:600]
        record["status"] = "applied" if ok else "apply_failed"
        log_record(os.path.join(cfg.records_dir, "minimax_log.jsonl"), record)
        print(f"[patch] apply={'OK' if ok else 'FAILED'} {message[:300]}")
        if not ok:
            return 4
    else:
        record["status"] = "patch_saved"
        log_record(os.path.join(cfg.records_dir, "minimax_log.jsonl"), record)
        print(f"[patch] 已保存到 {args.out_patch}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
