"""上下文选择：给定开发任务，从 seekdb 里取出"该守的规格 + 该改的代码 + 该跑的测试"。

选择策略（混合召回 + 关系扩展）
--------------------------------
1. 召回：任务文本向量化后在 seekdb 做 HNSW 近邻检索，同时用全文索引做关键词召回，
   两路结果按 ``0.65 * 向量分 + 0.35 * 关键词分`` 融合；
2. 规格：取融合得分最高的若干条；任务文本中显式点名的规格 ID 直接置顶；
3. 代码：由命中规格的 ``applies_to`` 反查文件，取文件内的符号（函数/方法/类），
   再用任务向量在代码工件里补召回，避免遗漏规格没写全的文件；
4. 测试：由规格 ``verifies`` 与测试工件里引用的规格 ID 建立映射，
   目标测试与回归测试分别标注角色；
5. 输出带来源（文件 + 行号 + 工件 ID + 内容修订号），可用 context_fingerprint 校验一致性。
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set

from .config import Config
from .db import SeekDB
from .ingest import SOURCE_SEP
from .embed import build_embedder, tokenize

WEIGHT_VECTOR = 0.65
WEIGHT_LEXICAL = 0.35
SPEC_RELATIVE_CUTOFF = 0.4   # 保留得分 >= 最高分 * 0.4 的规格
MAX_SPECS = 5
MAX_CODE_SYMBOLS = 14


@dataclass
class ContextBundle:
    task: str
    specs: List[Dict[str, Any]] = field(default_factory=list)
    code: List[Dict[str, Any]] = field(default_factory=list)
    tests: List[Dict[str, Any]] = field(default_factory=list)
    selection: Dict[str, Any] = field(default_factory=dict)
    evidence: Dict[str, Any] = field(default_factory=dict)
    fingerprint: str = ""

    # ---------------------------------------------------------------- 输出
    def to_dict(self) -> Dict[str, Any]:
        return {
            "task": self.task,
            "specs": self.specs,
            "code": self.code,
            "tests": self.tests,
            "selection": self.selection,
            "db_evidence": self.evidence,
            "context_fingerprint": self.fingerprint,
        }

    def sources(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for s in self.specs:
            out.append({"kind": "spec", "id": s["id"], "path": s["path"],
                        "line": s["line"], "title": s["title"], "revision": s["revision"]})
        for c in self.code:
            out.append({"kind": "code", "id": c["artifact_id"], "path": c["path"],
                        "line": c["start_line"], "end_line": c["end_line"],
                        "title": c["symbol"], "revision": c["revision"]})
        for t in self.tests:
            out.append({"kind": "test", "id": t["node_id"], "path": t["path"],
                        "line": t["line"], "title": t["test_name"], "revision": t["revision"]})
        return out

    def render_markdown(self) -> str:
        """把上下文渲染成给模型看的提示词主体（也是评审核对来源的凭据）。"""
        parts: List[str] = []
        parts.append(f"# 任务\n{self.task}\n")
        parts.append("# 适用规格（必须逐条满足）")
        for s in self.specs:
            parts.append(f"\n## [{s['id']}] {s['title']}\n"
                         f"来源: {s['path']}:{s['line']}\n\n{s['body']}")
        parts.append("\n# 需要修改的代码")
        for c in self.code:
            parts.append(f"\n## {c['symbol']}  ({c['path']}:{c['start_line']}-{c['end_line']})")
            parts.append(f"```python\n{c['source']}\n```")
        parts.append("\n# 验证测试")
        for t in self.tests:
            parts.append(f"- [{t['role']}] {t['node_id']}  (行 {t['line']})  意图: {t['purpose']}")
        return "\n".join(parts)


def _merge_hits(vec_hits: Sequence[Dict[str, Any]], lex_hits: Sequence[Dict[str, Any]],
                max_lex: float) -> Dict[str, Dict[str, Any]]:
    merged: Dict[str, Dict[str, Any]] = {}
    for hit in vec_hits:
        merged[hit["artifact_id"]] = dict(hit, lexical_score=0.0, matched_by=["vector"])
    for hit in lex_hits:
        aid = hit["artifact_id"]
        lex = float(hit.get("ft_score") or 0.0) / (max_lex or 1.0)
        if aid in merged:
            merged[aid]["lexical_score"] = lex
            merged[aid]["matched_by"].append("lexical")
        else:
            merged[aid] = dict(hit, vector_score=0.0, lexical_score=lex, matched_by=["lexical"])
    for rec in merged.values():
        rec["score"] = WEIGHT_VECTOR * float(rec.get("vector_score", 0.0)) + \
                       WEIGHT_LEXICAL * float(rec.get("lexical_score", 0.0))
    return merged


def _refs(rec: Dict[str, Any]) -> Dict[str, Any]:
    raw = rec.get("refs") or ""
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def build_context(task: str, cfg: Config, db: SeekDB, top_k: int = 20) -> ContextBundle:
    embedder = build_embedder(cfg)
    task_vec = embedder.embed(task)
    terms = sorted(set(tokenize(task)))[:20]

    vec_hits = db.vector_search(task_vec, top_k=top_k)
    try:
        lex_hits = db.fulltext_search(task, top_k=top_k)
        lexical_mode = "fulltext"
    except Exception:  # noqa: BLE001
        lex_hits = db.like_search(terms, top_k=top_k)
        lexical_mode = "like"
    max_lex = max([float(h.get("ft_score") or 0.0) for h in lex_hits], default=1.0)

    merged = _merge_hits(vec_hits, lex_hits, max_lex)

    # 任务里显式点名的规格 ID 直接提权
    mentioned = {t for t in task.split() if "-" in t}
    mentioned = {m.strip("，,。.:：") for m in mentioned}
    for rec in merged.values():
        if rec["kind"] == "spec":
            spec_id = _refs(rec).get("spec_id", "")
            if spec_id and spec_id in task:
                rec["score"] += 0.5
                rec["matched_by"].append("explicit_reference")

    # ---------------- 规格
    spec_hits = sorted([r for r in merged.values() if r["kind"] == "spec"],
                       key=lambda r: r["score"], reverse=True)
    if spec_hits:
        cutoff = spec_hits[0]["score"] * SPEC_RELATIVE_CUTOFF
        chosen = [r for r in spec_hits if r["score"] >= cutoff][:MAX_SPECS] or spec_hits[:1]
    else:
        chosen = []

    rows = db.get_artifacts([r["artifact_id"] for r in chosen]) if chosen else []
    by_id = {row["artifact_id"]: row for row in rows}
    specs: List[Dict[str, Any]] = []
    applies_to: List[str] = []
    verifies: List[str] = []
    spec_ids: Set[str] = set()
    spec_applies: Dict[str, List[str]] = {}
    for rec in chosen:
        row = by_id.get(rec["artifact_id"])
        if not row:
            continue
        refs = _refs(row)
        body = _slice_source(row["content"])
        sid = refs.get("spec_id") or row["symbol"]
        specs.append({
            "id": sid,
            "title": _strip_spec_prefix(row["title"], refs.get("spec_id") or row["symbol"]),
            "path": row["path"],
            "line": row["start_line"],
            "body": body,
            "score": round(rec["score"], 4),
            "matched_by": rec["matched_by"],
            "revision": row["revision"],
        })
        spec_ids.add(sid)
        spec_applies[sid] = refs.get("applies_to", [])
        applies_to.extend(refs.get("applies_to", []))
        verifies.extend(refs.get("verifies", []))
    applies_to = sorted(set(applies_to))
    verifies = sorted(set(verifies))

    # ---------------- 代码
    code: List[Dict[str, Any]] = []
    seen_symbols: Set[str] = set()
    task_terms = set(tokenize(task)) | set(tokenize(" ".join(s["body"] for s in specs)))

    def push_code(row: Dict[str, Any], reason: str) -> None:
        sym = row["symbol"]
        if sym == "<module>" or sym in seen_symbols:
            return
        if len(code) >= MAX_CODE_SYMBOLS:
            return
        seen_symbols.add(sym)
        code.append({
            "artifact_id": row["artifact_id"],
            "path": row["path"],
            "symbol": sym,
            "start_line": row["start_line"],
            "end_line": row["end_line"],
            "source": _slice_source(row["content"]),
            "reason": reason,
            "revision": row["revision"],
        })

    primary = [row for row in db.artifacts_by_path(applies_to) if row["symbol"] != "<module>"]
    file_priority: Dict[str, int] = {}
    for paths in spec_applies.values():
        for path in paths:
            file_priority[path] = file_priority.get(path, 0) + 1

    def code_order(row: Dict[str, Any]) -> tuple:
        name = row["symbol"].lower()
        named = any(term in name for term in task_terms if len(term) > 2)
        return (-file_priority.get(row["path"], 0), 0 if named else 1, row["path"], row["start_line"])

    for row in sorted(primary, key=code_order):
        push_code(row, f"规格 applies_to → {row['path']}")

    if len(code) < 3:
        # 规格里的 applies_to 不完整时，用任务向量在代码工件里补召回
        for rec in sorted([r for r in merged.values() if r["kind"] == "code"],
                          key=lambda r: r["score"], reverse=True):
            rows2 = db.get_artifacts([rec["artifact_id"]])
            if rows2:
                push_code(rows2[0], f"向量召回（score={rec['score']:.3f}）")

    # ---------------- 测试
    test_rows = db.artifacts_by_kind("test")
    tests: List[Dict[str, Any]] = []
    seen_nodes: Set[str] = set()
    for row in test_rows:
        refs = _refs(row)
        node_id = refs.get("node_id") or row["artifact_id"]
        row_specs = set(refs.get("spec_ids", []))
        in_verifies = any(row["path"] == v for v in verifies)
        hit_spec = bool(row_specs & spec_ids)
        file_role = refs.get("role", "regression")
        if not (in_verifies or hit_spec or file_role == "regression"):
            continue
        if node_id in seen_nodes:
            continue
        seen_nodes.add(node_id)
        purpose = _first_doc_line(_slice_source(row["content"]))
        tests.append({
            "node_id": node_id,
            "path": row["path"],
            "test_name": row["symbol"],
            "line": row["start_line"],
            "source": _slice_source(row["content"]),
            # 角色以测试文件本身的定位为准：target 文件是本次要转绿的功能测试，
            # regression 文件是必须保持绿色的既有行为
            "role": "target" if file_role == "target" else "regression",
            "covered_specs": sorted(row_specs),
            "purpose": purpose,
            "revision": row["revision"],
        })
    tests.sort(key=lambda t: (t["role"] != "target", t["node_id"]))

    bundle = ContextBundle(task=task, specs=specs, code=code, tests=tests)
    bundle.selection = {
        "strategy": "hybrid(vector+lexical) + spec-applies_to expansion",
        "weights": {"vector": WEIGHT_VECTOR, "lexical": WEIGHT_LEXICAL},
        "lexical_mode": lexical_mode,
        "mentioned_spec_ids": sorted(i for i in mentioned if i in spec_ids),
        "applies_to": applies_to,
        "verifies": verifies,
        "candidate_artifacts": len(merged),
    }
    bundle.evidence = {
        "db": f"{cfg.db_host}:{cfg.db_port}/{cfg.db_name}",
        "search_queries": ["vector_search", lexical_mode],
        "vector_hits": len(vec_hits),
        "lexical_hits": len(lex_hits),
        "spec_rows": len(specs),
        "code_rows": len(code),
        "test_rows": len(tests),
        "embed_model": embedder.name,
    }
    fingerprint_src = "|".join(
        f"{s['id']}:{s['revision']}" for s in specs
    ) + "|" + "|".join(f"{c['artifact_id']}:{c['revision']}" for c in code)
    bundle.fingerprint = hashlib.sha256(fingerprint_src.encode("utf-8")).hexdigest()[:16]
    return bundle


def _slice_source(content: str) -> str:
    """取工件的源码/正文部分。

    元信息与正文之间用 ingest.SOURCE_SEP 分隔；老数据（无分隔符）退回按空行切。
    """
    if SOURCE_SEP in content:
        return content.split(SOURCE_SEP, 1)[1]
    return content.split("\n\n", 1)[-1]


def _strip_spec_prefix(title: str, spec_id: str) -> str:
    """title 形如 "ORDER-REQ-004 订单状态过滤"，展示时去掉重复的 ID。"""
    if spec_id and title.startswith(spec_id):
        return title[len(spec_id):].strip() or title
    return title


def _first_doc_line(source: str) -> str:
    for line in source.splitlines():
        stripped = line.strip()
        if stripped.startswith('"""') and len(stripped) > 3:
            return stripped.strip('"').strip()
    for line in source.splitlines():
        if line.strip() and not line.strip().startswith(("def ", "@", "import", "from")):
            return line.strip()[:120]
    return ""
