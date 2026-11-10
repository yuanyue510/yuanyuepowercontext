"""任务状态：用 PowerContext 的 Memory 保存，重启后用检索读回。

一条状态记录包含：任务号、阶段、已完成项、待办项、验证结果、上下文指纹。
长文本证据（测试日志、上下文快照）另存为 Source，Memory 里只放引用，
避免单条 Memory 超过 8192 字节上限。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .pc_client import PowerContext, PowerContextError

STATE_KIND = "sdd_task_state"
STATE_TAG = "[SDD-STATE]"


@dataclass
class Verification:
    name: str
    command: str
    exit_code: int
    passed: Optional[int] = None
    failed: Optional[int] = None
    note: str = ""


@dataclass
class TaskState:
    task_id: str
    stage: str = "context_ready"
    completed: List[str] = field(default_factory=list)
    todo: List[str] = field(default_factory=list)
    verifications: List[Verification] = field(default_factory=list)
    context_fingerprint: str = ""
    evidence_source_id: str = ""
    updated_at: str = ""

    def to_text(self) -> str:
        payload = asdict(self)
        payload["updated_at"] = self.updated_at or _now()
        return STATE_TAG + " " + json.dumps(payload, ensure_ascii=False)

    @classmethod
    def from_text(cls, text: str) -> Optional["TaskState"]:
        raw = text.strip()
        if raw.startswith(STATE_TAG):
            raw = raw[len(STATE_TAG):].strip()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return None
        if not isinstance(data, dict) or "task_id" not in data:
            return None
        data["verifications"] = [Verification(**v) for v in data.get("verifications", [])]
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})

    def describe(self) -> str:
        lines = [
            f"任务: {self.task_id}",
            f"阶段: {self.stage}",
            f"更新时间: {self.updated_at}",
            f"上下文指纹: {self.context_fingerprint or '-'}",
            "已完成:",
        ]
        lines += [f"  ✓ {item}" for item in self.completed] or ["  (无)"]
        lines.append("待办:")
        lines += [f"  · {item}" for item in self.todo] or ["  (无)"]
        lines.append("验证结果:")
        if self.verifications:
            for v in self.verifications:
                mark = "PASS" if v.exit_code == 0 else "FAIL"
                detail = f"{v.passed} passed" if v.passed is not None else ""
                if v.failed:
                    detail += f", {v.failed} failed"
                lines.append(f"  [{mark}] {v.name} | rc={v.exit_code} {detail} | {v.command}")
        else:
            lines.append("  (无)")
        if self.evidence_source_id:
            lines.append(f"证据 Source: {self.evidence_source_id}")
        return "\n".join(lines)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def save_state(pc: PowerContext, state: TaskState) -> Dict[str, Any]:
    state.updated_at = _now()
    return pc.remember(
        kind=STATE_KIND,
        text=state.to_text(),
        description=f"SDD task state for {state.task_id} @ {state.stage}",
    )


def load_state(pc: PowerContext, task_id: str, limit: int = 20) -> Optional[TaskState]:
    """按任务号检索并还原最近一次状态。"""
    try:
        hits = pc.search(query=f"{STATE_TAG} {task_id}", limit=limit)
    except PowerContextError:
        return None
    best: Optional[TaskState] = None
    for hit in hits:
        memory = hit.get("memory", {})
        text = memory.get("text", "")
        parsed = TaskState.from_text(text)
        if parsed is None or parsed.task_id != task_id:
            continue
        if best is None or (parsed.updated_at or "") > (best.updated_at or ""):
            best = parsed
    return best


def save_evidence(pc: PowerContext, task_id: str, name: str, content: str,
                  metadata: Optional[Dict[str, Any]] = None) -> str:
    source_id = f"sdd-evidence-{task_id}-{name}"
    pc.capture_source(source_id, content, metadata or {"task_id": task_id, "name": name})
    return source_id
