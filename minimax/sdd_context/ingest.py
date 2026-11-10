"""资料导入：把规格（Markdown）、代码（Python AST）、测试（Python AST）拆成工件写入 seekdb。

每次导入都是"全量对齐 + 差集清理"：同名工件按内容哈希 REPLACE，
库中存在但本次扫描不到的工件会被删除，保证"规格改了重新导入"之后
检索结果立即反映新内容，而不是沿用旧缓存。
"""

from __future__ import annotations

import ast
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from .config import Config
from .db import SeekDB
from .embed import build_embedder

SPEC_HEAD = re.compile(r"^###\s+([A-Z][A-Z0-9-]*-\d+)\s+(.+?)\s*$")
META_LINE = re.compile(r"^-\s*([a-zA-Z_]+)\s*:\s*(.+)$")
REQ_ID = re.compile(r"[A-Z][A-Z0-9-]*-\d+")
# 元信息与正文之间的唯一分隔符。早先用空行分隔，会被 docstring/正文里的空行切错，
# 导致交给模型的代码片段从中间开始、无法生成合法补丁。
SOURCE_SEP = "\n\n@@@@ SOURCE @@@@\n\n"


def _md5(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


@dataclass
class IngestResult:
    run_id: str
    specs: int = 0
    code: int = 0
    tests: int = 0
    artifacts: List[Dict[str, Any]] = field(default_factory=list)
    removed: int = 0
    embed_model: str = ""
    caps: Dict[str, Any] = field(default_factory=dict)

    def summary(self) -> Dict[str, Any]:
        return {
            "run_id": self.run_id,
            "spec": self.specs,
            "code": self.code,
            "test": self.tests,
            "total": self.specs + self.code + self.tests,
            "removed": self.removed,
            "embed_model": self.embed_model,
            "caps": self.caps,
        }


# --------------------------------------------------------------------- 规格
def parse_specs(spec_dir: str, root: str) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    if not os.path.isdir(spec_dir):
        return items
    for name in sorted(os.listdir(spec_dir)):
        if not name.endswith(".md"):
            continue
        path = os.path.join(spec_dir, name)
        rel = os.path.relpath(path, root)
        lines = open(path, encoding="utf-8").read().splitlines()
        idx = 0
        while idx < len(lines):
            m = SPEC_HEAD.match(lines[idx])
            if not m:
                idx += 1
                continue
            spec_id, title = m.group(1), m.group(2)
            start = idx + 1
            cursor = start
            meta: Dict[str, str] = {}
            body_lines: List[str] = []
            in_meta = True
            while cursor < len(lines):
                line = lines[cursor]
                if SPEC_HEAD.match(line) or line.startswith("## "):
                    break
                if in_meta:
                    mm = META_LINE.match(line.strip())
                    if mm:
                        meta[mm.group(1).lower()] = mm.group(2).strip()
                        cursor += 1
                        continue
                    if line.strip() == "":
                        cursor += 1
                        continue
                    in_meta = False
                body_lines.append(line)
                cursor += 1
            body = "\n".join(body_lines).strip()
            applies_to = [p.strip() for p in meta.get("applies_to", "").split(",") if p.strip()]
            verifies = [p.strip() for p in meta.get("verifies", "").split(",") if p.strip()]
            tags = meta.get("tags", "")
            content = (
                f"{spec_id} {title}\n"
                f"applies_to: {', '.join(applies_to)}\n"
                f"verifies: {', '.join(verifies)}\n{tags}{SOURCE_SEP}{body}"
            )
            items.append({
                "artifact_id": f"spec:{spec_id}",
                "kind": "spec",
                "path": rel,
                "symbol": spec_id,
                "start_line": start,
                "end_line": cursor,
                "title": f"{spec_id} {title}",
                "content": content,
                "tags": tags,
                "meta": {"applies_to": applies_to, "verifies": verifies, "spec_id": spec_id},
                "refs": json.dumps({"applies_to": applies_to, "verifies": verifies,
                                    "spec_id": spec_id}, ensure_ascii=False),
                "revision": _md5(content),
            })
            idx = cursor
    return items


# --------------------------------------------------------------------- 代码
def _node_source(lines: List[str], node: ast.AST) -> str:
    start = (getattr(node, "lineno", 1) or 1) - 1
    end = getattr(node, "end_lineno", start + 1) or (start + 1)
    return "\n".join(lines[start:end])


def _signature(node: ast.AST) -> str:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        args = [a.arg for a in node.args.args]
        if node.args.vararg:
            args.append("*" + node.args.vararg.arg)
        if node.args.kwarg:
            args.append("**" + node.args.kwarg.arg)
        prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
        return f"{prefix} {node.name}({', '.join(args)})"
    if isinstance(node, ast.ClassDef):
        bases = [getattr(b, "id", "") for b in node.bases if getattr(b, "id", "")]
        return f"class {node.name}({', '.join(bases)})" if bases else f"class {node.name}"
    return ""


def parse_code(code_dir: str, root: str) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for dirpath, dirnames, filenames in os.walk(code_dir):
        dirnames[:] = [d for d in dirnames if d not in {"__pycache__", ".git", "tests"}]
        for fname in sorted(filenames):
            if not fname.endswith(".py"):
                continue
            path = os.path.join(dirpath, fname)
            rel = os.path.relpath(path, root).replace("\\", "/")
            try:
                src = open(path, encoding="utf-8").read()
                tree = ast.parse(src)
            except SyntaxError:
                continue
            lines = src.splitlines()

            def add(node: ast.AST, qualname: str) -> None:
                body = _node_source(lines, node)
                doc = ast.get_docstring(node) or ""
                sig = _signature(node)
                content = f"{rel} :: {qualname}\n{sig}\n{doc}{SOURCE_SEP}{body}"
                items.append({
                    "artifact_id": f"code:{rel}#{qualname}",
                    "kind": "code",
                    "path": rel,
                    "symbol": qualname,
                    "start_line": getattr(node, "lineno", 0),
                    "end_line": getattr(node, "end_lineno", 0),
                    "title": f"{qualname} @ {rel}",
                    "content": content,
                    "tags": "code",
                    "meta": {"qualname": qualname},
                    "refs": json.dumps({"module": rel, "qualname": qualname}, ensure_ascii=False),
                    "revision": _md5(content),
                })

            module_doc = ast.get_docstring(tree) or ""
            if module_doc:
                head = "\n".join(lines[:12])
                content = f"{rel} (module)\n{module_doc}{SOURCE_SEP}{head}"
                items.append({
                    "artifact_id": f"code:{rel}#module",
                    "kind": "code",
                    "path": rel,
                    "symbol": "<module>",
                    "start_line": 1,
                    "end_line": min(len(lines), 12),
                    "title": f"{rel} (module docstring)",
                    "content": content,
                    "tags": "code,module",
                    "meta": {"qualname": "<module>"},
                    "refs": json.dumps({"module": rel, "qualname": "<module>"}, ensure_ascii=False),
                    "revision": _md5(content),
                })
            for node in tree.body:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    add(node, node.name)
                elif isinstance(node, ast.ClassDef):
                    add(node, node.name)
                    for sub in node.body:
                        if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            add(sub, f"{node.name}.{sub.name}")
    return items


# --------------------------------------------------------------------- 测试
def parse_tests(test_dir: str, root: str) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    if not os.path.isdir(test_dir):
        return items
    for fname in sorted(os.listdir(test_dir)):
        if not (fname.startswith("test_") and fname.endswith(".py")):
            continue
        path = os.path.join(test_dir, fname)
        rel = os.path.relpath(path, root).replace("\\", "/")
        src = open(path, encoding="utf-8").read()
        lines = src.splitlines()
        try:
            tree = ast.parse(src)
        except SyntaxError:
            continue
        role = "target" if "_target" in fname else "regression"
        for node in tree.body:
            if not isinstance(node, ast.FunctionDef) or not node.name.startswith("test_"):
                continue
            doc = ast.get_docstring(node) or ""
            spec_ids = sorted(set(REQ_ID.findall(doc)))
            body = _node_source(lines, node)
            content = (f"{rel}::{node.name}\nrole={role}\nspecs={','.join(spec_ids)}\n"
                       f"{doc}{SOURCE_SEP}{body}")
            items.append({
                "artifact_id": f"test:{rel}::{node.name}",
                "kind": "test",
                "path": rel,
                "symbol": node.name,
                "start_line": node.lineno,
                "end_line": getattr(node, "end_lineno", node.lineno),
                "title": f"{node.name} @ {rel}",
                "content": content,
                "tags": f"test,{role}," + ",".join(spec_ids),
                "meta": {"role": role, "spec_ids": spec_ids, "node_id": f"{rel}::{node.name}"},
                "refs": json.dumps({"role": role, "spec_ids": spec_ids,
                                    "node_id": f"{rel}::{node.name}"}, ensure_ascii=False),
                "revision": _md5(content),
            })
    return items


# --------------------------------------------------------------------- 入口
def ingest(root: str, cfg: Config, db: SeekDB, prune: bool = True) -> IngestResult:
    root = os.path.abspath(root)
    run_id = datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%SZ")
    db.start_run(run_id)

    specs = parse_specs(os.path.join(root, "specs"), root)
    code = parse_code(os.path.join(root, "ordersvc"), root)
    tests = parse_tests(os.path.join(root, "tests"), root)
    items = specs + code + tests

    embedder = build_embedder(cfg)
    vectors = embedder.embed_many([it["content"] for it in items]) if items else []
    embeddings = {it["artifact_id"]: vec for it, vec in zip(items, vectors)}

    db.replace_artifacts(items, embeddings, embedder.name)
    removed = db.delete_missing([it["artifact_id"] for it in items]) if prune else 0
    db.finish_run(run_id, len(specs), len(code), len(tests),
                  note=f"embed={embedder.name}")

    return IngestResult(
        run_id=run_id,
        specs=len(specs), code=len(code), tests=len(tests),
        artifacts=items, removed=removed, embed_model=embedder.name,
    )
