# Copyright (c) 2026 OceanBase.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Pi session branch capture: raw visible events, evidence projection, incremental import."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any
from urllib.parse import quote

from pydantic import BaseModel, JsonValue

from powercontext.sources import TEXT_EVIDENCE_PROJECTION_KEY, AdapterSourceDefinition, TextEvidence
from powercontext.sources.connectors import (
    ConnectorRunCompletion,
    ConnectorRunSession,
    ConnectorRunStatus,
)
from powercontext.sources.models import Source, SourceMaterialization

PI_EVENT_SOURCE_NAME = "pi-event"
PI_SESSION_CONNECTOR_NAME = "pi-session-history"

_IDENTITY_PREFIX = "pi"
_MAX_IDENTITY_LENGTH = 256
_COMPACT_JSON = (",", ":")


def _require_trimmed_part(name: str, value: object, /) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(f"{name} must be a non-empty trimmed string")
    return value


def pi_event_source_id(session_id: str, event_id: str, /) -> str:
    """Return the fixed ``pi:{session}:{event}`` identity, collision-free and bounded."""

    _require_trimmed_part("session_id", session_id)
    _require_trimmed_part("event_id", event_id)
    identity = f"{_IDENTITY_PREFIX}:{quote(session_id, safe='')}:{quote(event_id, safe='')}"
    if len(identity) > _MAX_IDENTITY_LENGTH:
        raise ValueError("pi event source identity must not exceed 256 characters")
    return identity


class PiSessionInput(BaseModel):
    """Complete Pi session JSONL bytes with an optional explicitly selected leaf."""

    content: bytes
    leaf_id: str | None = None


class PiEventInput(BaseModel):
    """One raw visible event on the selected branch, keeping the complete record."""

    session_id: str
    event_id: str
    parent_id: str | None
    event_type: str
    role: str
    content: str
    record: dict[str, JsonValue]


class PiEventSource(Source):
    """Durable captured evidence for exactly one Pi session event."""

    session_id: str
    event_id: str
    parent_id: str | None
    event_type: str
    role: str
    content: str
    record: dict[str, JsonValue]


def _join_text_blocks(blocks: object, /) -> str | None:
    parts: list[str] = []
    if isinstance(blocks, str):
        if blocks:
            parts.append(blocks)
    elif isinstance(blocks, list):
        for block in blocks:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str) and text:
                    parts.append(text)
    if not parts:
        return None
    return "\n".join(parts)


def _message_body(message: dict[str, JsonValue], /) -> str | None:
    role = message.get("role")
    if not isinstance(role, str) or not role:
        raise ValueError("message records require a non-empty role")
    if role == "toolResult":
        text = _join_text_blocks(message.get("content"))
        if text is None:
            return None
        tool_name = message.get("toolName")
        tool_call_id = message.get("toolCallId")
        return (
            f"[tool_result {tool_name if isinstance(tool_name, str) else ''} "
            f"{tool_call_id if isinstance(tool_call_id, str) else ''}] {text}"
        )
    if role == "bashExecution":
        command = message.get("command")
        output = message.get("output")
        if not isinstance(command, str) or not command:
            return None
        body = f"$ {command}"
        if isinstance(output, str) and output:
            body = f"{body}\n{output}"
        return body
    content = message.get("content")
    parts: list[str] = []
    if isinstance(content, str):
        if content:
            parts.append(content)
    elif isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text":
                text = block.get("text")
                if isinstance(text, str) and text:
                    parts.append(text)
            elif block_type == "toolCall":
                arguments = block.get("arguments")
                rendered = json.dumps(
                    {} if arguments is None else arguments,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=_COMPACT_JSON,
                )
                name = block.get("name")
                call_id = block.get("id")
                parts.append(
                    f"[tool_call {name if isinstance(name, str) else ''} "
                    f"{call_id if isinstance(call_id, str) else ''}] {rendered}"
                )
    if not parts:
        return None
    return "\n".join(parts)


def _visible_event(
    session_id: str,
    event_id: str,
    parent_id: str | None,
    record: dict[str, JsonValue],
    /,
) -> PiEventInput | None:
    event_type = record.get("type")
    if event_type == "message":
        message = record.get("message")
        if not isinstance(message, dict):
            raise ValueError("message records require a message object")
        role = message.get("role")
        if not isinstance(role, str) or not role:
            raise ValueError("message records require a non-empty role")
        body = _message_body(message)
        if body is None:
            return None
        return PiEventInput(
            session_id=session_id,
            event_id=event_id,
            parent_id=parent_id,
            event_type="message",
            role=role,
            content=f"{role}: {body}",
            record=record,
        )
    if event_type in ("compaction", "branch_summary"):
        summary = record.get("summary")
        if not isinstance(summary, str) or not summary:
            return None
        return PiEventInput(
            session_id=session_id,
            event_id=event_id,
            parent_id=parent_id,
            event_type=event_type,
            role=event_type,
            content=f"{event_type}: {summary}",
            record=record,
        )
    if event_type == "custom_message":
        body = _join_text_blocks(record.get("content"))
        if body is None:
            return None
        return PiEventInput(
            session_id=session_id,
            event_id=event_id,
            parent_id=parent_id,
            event_type="custom_message",
            role="custom",
            content=f"custom: {body}",
            record=record,
        )
    return None


def parse_pi_session(value: PiSessionInput, /) -> tuple[PiEventInput, ...]:
    """Parse the selected branch atomically, root-to-leaf, or raise ``ValueError``."""

    try:
        text = value.content.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError("pi session content must decode as strict UTF-8") from error

    records: list[dict[str, JsonValue]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"malformed pi session json: {error}") from error
        if not isinstance(record, dict):
            raise ValueError("pi session records must be json objects")
        records.append(record)
    if not records:
        raise ValueError("pi session requires a session header record")
    header = records[0]
    if header.get("type") != "session" or header.get("version") != 3:
        raise ValueError("pi session header must declare type=session and version=3")
    session_id = header.get("id")
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("pi session header requires a non-empty id")

    nodes: dict[str, dict[str, JsonValue]] = {}
    parents: dict[str, str | None] = {}
    order: list[str] = []
    seen: set[str] = set()
    for record in records[1:]:
        node_id = record.get("id")
        if not isinstance(node_id, str) or not node_id:
            raise ValueError("pi session nodes require non-empty string ids")
        if node_id in nodes:
            raise ValueError(f"duplicate pi session node id {node_id!r}")
        if "parentId" not in record:
            raise ValueError(f"pi session node {node_id!r} requires a parentId")
        parent_id = record["parentId"]
        if parent_id is not None:
            if not isinstance(parent_id, str) or parent_id not in seen:
                raise ValueError(f"pi session node {node_id!r} references a missing parent")
        nodes[node_id] = record
        parents[node_id] = parent_id
        seen.add(node_id)
        order.append(node_id)

    if value.leaf_id is None:
        if not order:
            return ()
        leaf_id = order[-1]
    else:
        if value.leaf_id not in nodes:
            raise ValueError(f"selected leaf {value.leaf_id!r} is missing from the session")
        leaf_id = value.leaf_id

    chain: list[str] = []
    current: str | None = leaf_id
    visited: set[str] = set()
    while current is not None:
        if current in visited:
            raise ValueError("pi session parent graph contains a cycle")
        visited.add(current)
        chain.append(current)
        current = parents[current]
    chain.reverse()

    events: list[PiEventInput] = []
    for node_id in chain:
        event = _visible_event(session_id, node_id, parents[node_id], nodes[node_id])
        if event is not None:
            events.append(event)
    return tuple(events)


class PiEventSourceAdapter:
    """Resolve and read the immutable Pi event Source for one exact input class."""

    input_class = PiEventInput
    name = PI_EVENT_SOURCE_NAME
    source_class = PiEventSource

    async def resolve(self, value: PiEventInput, /) -> PiEventSource:
        identity = pi_event_source_id(value.session_id, value.event_id)
        return PiEventSource(
            name=identity,
            materialization=SourceMaterialization.CAPTURED,
            session_id=value.session_id,
            event_id=value.event_id,
            parent_id=value.parent_id,
            event_type=value.event_type,
            role=value.role,
            content=value.content,
            record=value.record,
        )

    async def read(self, source: PiEventSource, /) -> PiEventInput:
        return PiEventInput(
            session_id=source.session_id,
            event_id=source.event_id,
            parent_id=source.parent_id,
            event_type=source.event_type,
            role=source.role,
            content=source.content,
            record=source.record,
        )


class PiEventTextEvidenceProjection:
    """Expose one event as the standard ``powercontext.text-evidence`` shape."""

    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = PiEventSource
    output_class = TextEvidence

    def project(self, source: PiEventSource, /) -> TextEvidence:
        return TextEvidence(
            source_type=PI_EVENT_SOURCE_NAME,
            source_id=source.name,
            content=source.content,
            metadata={
                "session_id": source.session_id,
                "event_id": source.event_id,
                "parent_id": source.parent_id,
                "event_type": source.event_type,
                "role": source.role,
            },
        )


PI_EVENT_SOURCE_DEFINITION = AdapterSourceDefinition(
    PiEventSourceAdapter(),
    version="1",
    projections=(PiEventTextEvidenceProjection(),),
)


def _record_fingerprint(record: dict[str, JsonValue], /) -> str:
    canonical = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=_COMPACT_JSON)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class _ImportedEvents:
    """Durable set of imported event ids plus their original record fingerprints."""

    def __init__(self, events: dict[str, str], /) -> None:
        self.events = events

    @classmethod
    def from_json(cls, checkpoint: object, /) -> _ImportedEvents:
        if checkpoint is None:
            return cls({})
        if not isinstance(checkpoint, dict) or not isinstance(checkpoint.get("events"), dict):
            raise ValueError("pi session checkpoint is malformed")
        events = checkpoint["events"]
        if not all(isinstance(key, str) and isinstance(value, str) for key, value in events.items()):
            raise ValueError("pi session checkpoint is malformed")
        return cls(dict(events))

    def to_json(self) -> dict[str, Any]:
        return {"events": self.events}


class PiSessionConnector:
    """Incrementally import the selected branch with a lifecycle-owned checkpoint."""

    name = PI_SESSION_CONNECTOR_NAME
    version = "1"
    source_definitions = frozenset({PI_EVENT_SOURCE_NAME})

    def __init__(self, path: str | Path, leaf_id: str | None = None, /) -> None:
        self._path = Path(path)
        self._leaf_id = leaf_id

    async def run(self, session: ConnectorRunSession, /) -> ConnectorRunCompletion:
        content = self._path.read_bytes()
        events = parse_pi_session(PiSessionInput(content=content, leaf_id=self._leaf_id))
        imported = _ImportedEvents.from_json(session.checkpoint)

        for event in events:
            fingerprint = _record_fingerprint(event.record)
            known = imported.events.get(event.event_id)
            if known is not None and known != fingerprint:
                raise ValueError(f"imported pi event {event.event_id!r} was rewritten")

        for event in events:
            if event.event_id in imported.events:
                continue
            identity = pi_event_source_id(event.session_id, event.event_id)
            await session.submit(identity, PI_EVENT_SOURCE_NAME, event)
            imported.events[event.event_id] = _record_fingerprint(event.record)
        return ConnectorRunCompletion(
            status=ConnectorRunStatus.COMPLETE,
            checkpoint=imported.to_json(),
        )


__all__ = [
    "PI_EVENT_SOURCE_DEFINITION",
    "PiEventInput",
    "PiSessionConnector",
    "PiSessionInput",
    "parse_pi_session",
]
