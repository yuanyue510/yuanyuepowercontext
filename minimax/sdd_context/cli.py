"""sdd_context 命令行入口。

常用命令::

    python -m sdd_context init-db
    python -m sdd_context ingest --root ./sample_project
    python -m sdd_context context --task "..." --out records/ctx.json
    python -m sdd_context state-save --task-id T1 --file records/state.json
    python -m sdd_context state-show --task-id T1
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional

from .config import Config
from .db import SeekDB
from .ingest import ingest
from .pc_client import PowerContext
from .retrieve import build_context
from .state import TaskState, Verification, load_state, save_evidence, save_state


def _db(cfg: Config) -> SeekDB:
    return SeekDB(cfg)


def cmd_init_db(args: argparse.Namespace, cfg: Config) -> int:
    db = _db(cfg)
    caps = db.init_schema()
    print(f"seekdb: {cfg.db_host}:{cfg.db_port}  database={cfg.db_name}")
    print(f"schema ready, capabilities={json.dumps(caps, ensure_ascii=False)}")
    stats = db.stats()
    print(f"artifacts={stats['total']} embeddings={stats['embeddings']}")
    return 0


def cmd_ingest(args: argparse.Namespace, cfg: Config) -> int:
    db = _db(cfg)
    db.init_schema()
    result = ingest(args.root, cfg, db, prune=not args.no_prune)
    summary = result.summary()
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    for item in result.artifacts:
        if item["kind"] == "spec":
            print(f"  spec  {item['symbol']:<16} {item['path']}:{item['start_line']}")
    print(f"导入完成：{summary['total']} 个工件（规格 {summary['spec']} / 代码 {summary['code']}"
          f" / 测试 {summary['test']}），清理 {summary['removed']} 个失效工件")
    return 0


def cmd_context(args: argparse.Namespace, cfg: Config) -> int:
    db = _db(cfg)
    bundle = build_context(args.task, cfg, db)
    payload = bundle.to_dict()

    out = args.out
    if out:
        os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)

    if args.render:
        print(bundle.render_markdown())
        return 0

    print("=" * 78)
    print(f"任务: {bundle.task}")
    print(f"上下文指纹: {bundle.fingerprint}   候选工件: "
          f"{bundle.selection.get('candidate_artifacts')}   检索方式: "
          f"{bundle.selection.get('lexical_mode')}")
    print("=" * 78)
    print("\n[适用规格]")
    for s in bundle.specs:
        print(f"  · {s['id']:<14} {s['title'][:46]:<46} {s['path']}:{s['line']}  score={s['score']}")
    print("\n[需要修改的代码]")
    for c in bundle.code:
        print(f"  · {c['symbol']:<38} {c['path']}:{c['start_line']}-{c['end_line']}")
    print("\n[验证测试]")
    for t in bundle.tests:
        print(f"  · [{t['role']:<10}] {t['node_id']:<52} {t['covered_specs']}")
    if out:
        print(f"\n上下文已写入 {out}")
    if not bundle.specs:
        print("\n[warn] 未命中任何规格，请检查任务描述或重新 ingest")
        return 2
    return 0


def cmd_state_save(args: argparse.Namespace, cfg: Config) -> int:
    pc = PowerContext(cfg)
    pc.ensure_scope(title=args.scope_title, summary="SDD 上下文管理系统的任务状态")
    state: TaskState
    if args.file:
        with open(args.file, encoding="utf-8") as fh:
            raw = json.load(fh)
        raw.setdefault("task_id", args.task_id or "")
        raw["verifications"] = [Verification(**v) for v in raw.get("verifications", [])]
        known = {f for f in TaskState.__dataclass_fields__}  # type: ignore[attr-defined]
        state = TaskState(**{k: v for k, v in raw.items() if k in known})
    else:
        state = TaskState(task_id=args.task_id or "", stage=args.stage,
                          completed=args.completed or [], todo=args.todo or [],
                          context_fingerprint=args.fingerprint or "")
    if args.task_id:
        state.task_id = args.task_id
    result = save_state(pc, state)
    print(f"PowerContext scope={pc.scope_id} 已保存任务状态: {state.task_id}")
    print(json.dumps(result, ensure_ascii=False)[:400])
    return 0


def cmd_state_show(args: argparse.Namespace, cfg: Config) -> int:
    pc = PowerContext(cfg)
    pc.ensure_scope(title=args.scope_title, summary="SDD 上下文管理系统的任务状态")
    state = load_state(pc, args.task_id)
    if state is None:
        print(f"[miss] PowerContext 中没有任务 {args.task_id} 的状态记录")
        return 1
    print(f"[hit] scope={pc.scope_id}")
    print(state.describe())
    if args.json:
        print(json.dumps(state.__dict__, ensure_ascii=False, indent=2))
    return 0


def cmd_evidence(args: argparse.Namespace, cfg: Config) -> int:
    pc = PowerContext(cfg)
    pc.ensure_scope(title=args.scope_title, summary="SDD 上下文管理系统的任务状态")
    content = open(args.file, encoding="utf-8", errors="replace").read()
    sid = save_evidence(pc, args.task_id, args.name, content,
                        {"task_id": args.task_id, "name": args.name, "kind": args.kind})
    print(f"证据已写入 Source: {sid} ({len(content)} bytes)")
    return 0


def cmd_stats(args: argparse.Namespace, cfg: Config) -> int:
    db = _db(cfg)
    print(json.dumps(db.stats(), ensure_ascii=False, indent=2, default=str))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="sdd_context", description="SDD 工程上下文模块")
    p.add_argument("--env-file", default=os.environ.get("SDD_ENV_FILE"),
                   help="可选的环境文件路径（默认读环境变量）")
    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("init-db", help="建库建表（含向量索引与全文索引）")
    sp.set_defaults(func=cmd_init_db)

    sp = sub.add_parser("ingest", help="导入规格/代码/测试到 seekdb")
    sp.add_argument("--root", default="sample_project")
    sp.add_argument("--no-prune", action="store_true", help="不清理库中多余工件")
    sp.set_defaults(func=cmd_ingest)

    sp = sub.add_parser("context", help="为任务构造开发上下文")
    sp.add_argument("--task", required=True)
    sp.add_argument("--out", default="")
    sp.add_argument("--render", action="store_true", help="打印给模型看的 Markdown")
    sp.set_defaults(func=cmd_context)

    scope_args = ("--scope-title",)
    for name, func in (("state-save", cmd_state_save), ("state-show", cmd_state_show)):
        sp = sub.add_parser(name)
        sp.add_argument("--task-id", default="")
        sp.add_argument("--scope-title", default="sdd-context-demo")
        sp.set_defaults(func=func)
        if name == "state-save":
            sp.add_argument("--file", default="")
            sp.add_argument("--stage", default="context_ready")
            sp.add_argument("--completed", action="append")
            sp.add_argument("--todo", action="append")
            sp.add_argument("--fingerprint", default="")
        else:
            sp.add_argument("--json", action="store_true")

    sp = sub.add_parser("evidence", help="把日志等长文本存为 PowerContext Source")
    sp.add_argument("--task-id", required=True)
    sp.add_argument("--name", required=True)
    sp.add_argument("--file", required=True)
    sp.add_argument("--kind", default="test-log")
    sp.add_argument("--scope-title", default="sdd-context-demo")
    sp.set_defaults(func=cmd_evidence)

    sp = sub.add_parser("stats", help="查看库内工件统计")
    sp.set_defaults(func=cmd_stats)
    return p


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    cfg = Config.from_env(args.env_file)
    try:
        return args.func(args, cfg)
    except Exception as exc:  # noqa: BLE001
        print(f"[error] {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
