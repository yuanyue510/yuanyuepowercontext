"""轻量 unified diff 应用器。

为什么不直接调用 `patch`：
    CentOS 7 最小安装、很多容器镜像里都没有 `patch`，评审的干净环境同样可能缺。
    本模块用纯 Python 解析并应用补丁，零外部依赖；`patch` / `git apply` 只作兜底。

支持的补丁形态：
    diff --git a/x b/x  +  --- a/x / +++ b/x  +  @@ -l,s +l,s @@
    也支持不带 a/ b/ 前缀的 --- x / +++ x。

匹配策略：
    严格按行号落点匹配；若行号已漂移（模型按自己的行号写补丁），在 ±WINDOW 行内
    滑动找到唯一匹配位置再落；找不到或有歧义则判定失败，绝不猜。
"""

from __future__ import annotations

import os
import re
from typing import Dict, List, Optional, Tuple

WINDOW = 60

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


class PatchError(Exception):
    pass


def _strip_prefix(path: str) -> str:
    path = path.strip().split("\t")[0].strip()
    if path.startswith('"') and path.endswith('"'):
        path = path[1:-1]
    for pre in ("a/", "b/"):
        if path.startswith(pre):
            return path[len(pre):]
    return path


def parse_patch(patch_text: str) -> Dict[str, List[Tuple[int, List[str], List[str]]]]:
    """解析成 {相对路径: [(old_start, old_lines, new_lines), ...]}。

    old_lines / new_lines 只保留行内容，不含 +/-/空格前缀。
    """
    files: Dict[str, List[Tuple[int, List[str], List[str]]]] = {}
    current: Optional[str] = None
    lines = patch_text.split("\n")
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if line.startswith("diff --git "):
            m = re.match(r"diff --git (\S+) (\S+)", line)
            current = _strip_prefix(m.group(2)) if m else None
            if current:
                files.setdefault(current, [])
            i += 1
            continue
        if line.startswith("--- "):
            nxt = lines[i + 1] if i + 1 < n else ""
            if nxt.startswith("+++ "):
                target = _strip_prefix(nxt[4:])
                src = _strip_prefix(line[4:])
                current = target if target != "/dev/null" else src
                if current and current != "/dev/null":
                    files.setdefault(current, [])
                i += 2
                continue
        m = HUNK_RE.match(line)
        if m and current:
            old_start = int(m.group(1))
            i += 1
            old_lines: List[str] = []
            new_lines: List[str] = []
            while i < n:
                body = lines[i]
                if body.startswith("@@") or body.startswith("diff --git ") or body.startswith("--- "):
                    break
                if body.startswith("\\"):          # \ No newline at end of file
                    i += 1
                    continue
                if body == "" and i == n - 1:      # 补丁末尾空行
                    i += 1
                    break
                tag, text = body[:1], body[1:]
                if tag == " ":
                    old_lines.append(text)
                    new_lines.append(text)
                elif tag == "-":
                    old_lines.append(text)
                elif tag == "+":
                    new_lines.append(text)
                else:
                    break                          # 非法行，交给上层判失败
                i += 1
            files[current].append((old_start, old_lines, new_lines))
            continue
        i += 1
    return {k: v for k, v in files.items() if v}


def _find(haystack: List[str], needle: List[str], guess: int) -> Optional[int]:
    """在 guess 附近找 needle 的唯一落点。"""
    if not needle:
        return max(0, min(guess, len(haystack)))
    limit = len(haystack) - len(needle)
    if limit < 0:
        return None
    start = max(0, guess - WINDOW)
    end = min(limit, guess + WINDOW)
    hits = [i for i in range(start, end + 1) if haystack[i:i + len(needle)] == needle]
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        if guess in hits:
            return guess                       # 歧义但猜中的位置正好命中，取它
        raise PatchError(
            f"上下文在 {hits[:5]} 多处匹配，无法确定落点（拒绝猜测）")
    return None


def apply_patch_text(project_dir: str, patch_text: str) -> Tuple[bool, str]:
    """把补丁应用到 project_dir 下的文件。返回 (是否成功, 说明)。"""
    try:
        files = parse_patch(patch_text)
    except PatchError as exc:
        return False, str(exc)
    if not files:
        return False, "补丁里没有可解析的 hunk"

    staged: Dict[str, List[str]] = {}
    report: List[str] = []

    for rel, hunks in files.items():
        path = os.path.join(project_dir, rel)
        if not os.path.isfile(path):
            return False, f"目标文件不存在: {rel}"
        with open(path, encoding="utf-8") as fh:
            content = fh.read()
        lines = content.split("\n")

        offset = 0
        applied = 0
        for old_start, old_lines, new_lines in hunks:
            guess = old_start - 1 + offset
            idx = _find(lines, old_lines, guess)
            if idx is None:
                return False, (f"{rel}: hunk @@ -{old_start} 的上下文在上文找不到"
                               f"（可能模型引用了旧版本代码）")
            lines[idx:idx + len(old_lines)] = new_lines
            offset += len(new_lines) - len(old_lines)
            applied += 1
        staged[rel] = lines
        report.append(f"{rel}: {applied} 个 hunk")

    for rel, lines in staged.items():
        with open(os.path.join(project_dir, rel), "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines))
    return True, "; ".join(report)


def changed_files(patch_text: str) -> List[str]:
    try:
        return sorted(parse_patch(patch_text).keys())
    except PatchError:
        return []
